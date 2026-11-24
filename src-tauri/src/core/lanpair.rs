//! LAN handshake for pairing: finding the other device and agreeing on six digits.
//!
//! status-go moves the profile; it does not find the other device, and it has no
//! cryptographic handshake that hands the connection string over. This module supplies
//! both, so that nobody has to read four hundred base58 characters off a screen.
//!
//! # The shape of the exchange
//!
//! 1. The receiver listens on a fixed UDP port for a probe and answers it with its
//!    one-time X25519 public key and the port of its handshake listener. The answer
//!    carries **no secret**: the key is used once and thrown away.
//! 2. The sender connects over TCP and sends its own one-time public key.
//! 3. Both sides compute the shared secret and derive a session key plus six digits
//!    from it. The digits are bound to the transcript — both public keys and both
//!    nonces — so they describe *this* exchange, not merely a secret.
//! 4. A human compares the digits. Each side presses Sync; the receiver proves it holds
//!    the key, the sender answers with the connection string, sealed.
//! 5. The receiver connects to status-go's pairing server with that string and takes
//!    the profile in.
//!
//! # Why the digits catch a man in the middle
//!
//! An attacker between the devices cannot share one secret with both sides, so it has
//! to run two handshakes. Each side then derives digits from a different secret, the
//! two people see different numbers, and nobody presses Sync. The connection string is
//! sent only after both have pressed, so it is not exposed even to an attacker that the
//! user ignored.
//!
//! # What is never logged
//!
//! The digits are short enough to guess in one conversation, and the connection string
//! is the key to the profile. Only phases, addresses and lengths reach the trace.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream, UdpSocket};
use tokio::sync::Notify;
use tokio::time::Instant;

use crate::core::error::{AppError, AppResult};

/// UDP port the receiver listens on and the sender probes.
///
/// Fixed because the two devices share nothing before the handshake: a port chosen at
/// random would have to be told to the other side somehow, which is the problem this
/// module exists to solve.
const DISCOVERY_PORT: u16 = 47831;

/// Datagram tag of a probe: "is a device there?".
const PROBE_TAG: &[u8; 4] = b"STP1";

/// Datagram tag of an answer to a probe.
const REPLY_TAG: &[u8; 4] = b"STR1";

/// Tag of the sender's first TCP frame.
const HELLO_TAG: &[u8; 4] = b"STH1";

/// How long a whole attempt lives, in seconds.
///
/// The same five minutes status-go gives its own pairing server. It covers discovery,
/// the codes being read off two screens, and both presses of Sync.
const ATTEMPT_TTL: Duration = Duration::from_secs(300);

/// How often the sender repeats its probe while alone on the network.
const PROBE_INTERVAL: Duration = Duration::from_millis(500);

/// How long a single TCP step may take.
const STEP_TIMEOUT: Duration = Duration::from_secs(20);

/// Largest frame accepted from the other device.
///
/// A connection string is well under a kilobyte; anything near this limit is either a
/// protocol error or an attempt to make the reader allocate.
const MAX_FRAME: usize = 8 * 1024;

/// What the screens poll while a transfer is running.
#[derive(Debug, Clone, Default, Serialize)]
pub struct LanStatus {
    /// `idle`, `waiting`, `codes`, `transferring`, `done` or `failed`.
    pub phase: String,
    /// Six digits for the comparison, once both sides hold the session key.
    pub digits: Option<String>,
    /// Why the attempt stopped, when it did.
    pub error: Option<String>,
    /// Key uid of the profile that arrived, on the receiving side.
    pub key_uid: Option<String>,
    /// Its display name, when the sender had one.
    pub name: Option<String>,
}

/// Keys and digits both sides derive from one exchange.
///
/// @remarks
/// Two directions, not one: the receiver's confirmation and the sender's string must not
/// share a key, or a captured frame could be replayed in the other direction.
struct SessionKeys {
    /// Seals the connection string.
    sender_to_receiver: [u8; 32],
    /// Seals the receiver's confirmation.
    receiver_to_sender: [u8; 32],
    /// Six digits, identical on both screens.
    digits: String,
}

/// What a probe answer carries.
struct Reply {
    /// The receiver's one-time public key.
    public: [u8; 32],
    /// The receiver's 16 random bytes, part of the transcript.
    nonce: [u8; 16],
    /// Port of the receiver's handshake listener.
    port: u16,
}

/// A running attempt, as seen by the commands.
struct Running {
    /// Status the screens poll.
    status: Arc<Mutex<LanStatus>>,
    /// Pressed when the user confirms the digits.
    confirm: Arc<Notify>,
    /// Set when the user leaves the screen.
    cancel: Arc<AtomicBool>,
    /// The task doing the work, so cancelling can stop it.
    task: tokio::task::JoinHandle<()>,
}

/// The one attempt this process can have.
///
/// Pairing is a global operation — one profile leaves, one arrives — and status-go's
/// pairing state is global too. A second attempt would fight the first.
static RUNNING: Mutex<Option<Running>> = Mutex::new(None);

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

/// Reads the current attempt status, or the idle one.
fn snapshot(status: &Arc<Mutex<LanStatus>>) -> LanStatus {
    lock(status).clone()
}

/// The status shown when no attempt is running.
fn idle() -> LanStatus {
    LanStatus {
        phase: "idle".to_string(),
        ..LanStatus::default()
    }
}

/// Moves an attempt to another phase.
fn set_phase(status: &Arc<Mutex<LanStatus>>, phase: &str) {
    lock(status).phase = phase.to_string();
}

/// Records a failure, never overwriting a success.
fn fail(status: &Arc<Mutex<LanStatus>>, message: impl Into<String>) {
    let mut current = lock(status);
    if current.phase == "done" {
        return;
    }
    current.phase = "failed".to_string();
    current.error = Some(message.into());
}

/// Publishes the digits and moves to the comparison phase.
fn publish_codes(status: &Arc<Mutex<LanStatus>>, digits: String) {
    crate::core::trace::line("pairing lan codes ready");
    let mut current = lock(status);
    current.digits = Some(digits);
    current.phase = "codes".to_string();
}

/// Marks the attempt finished.
fn publish_done(status: &Arc<Mutex<LanStatus>>, key_uid: Option<String>, name: Option<String>) {
    let mut current = lock(status);
    current.phase = "done".to_string();
    current.key_uid = key_uid;
    current.name = name;
}

/// Stops whatever attempt is running and forgets it.
fn stop_running() {
    if let Some(running) = lock(&RUNNING).take() {
        running.cancel.store(true, Ordering::SeqCst);
        running.task.abort();
    }
}

/// Installs a new attempt, replacing any previous one.
fn install(
    status: Arc<Mutex<LanStatus>>,
    confirm: Arc<Notify>,
    cancel: Arc<AtomicBool>,
    task: tokio::task::JoinHandle<()>,
) {
    stop_running();
    *lock(&RUNNING) = Some(Running {
        status,
        confirm,
        cancel,
        task,
    });
}

/// `N` random bytes from the platform generator.
fn random<const N: usize>() -> AppResult<[u8; N]> {
    let mut bytes = [0u8; N];
    getrandom::getrandom(&mut bytes)
        .map_err(|e| AppError::internal(format!("no randomness: {e}")))?;
    Ok(bytes)
}

/// The public half of an X25519 one-time key.
fn public_of(secret: &[u8; 32]) -> [u8; 32] {
    let secret = x25519_dalek::StaticSecret::from(*secret);
    *x25519_dalek::PublicKey::from(&secret).as_bytes()
}

/// The shared secret of one exchange.
///
/// @returns The 32-byte X25519 result.
/// @remarks
/// An all-zero result means the other side sent a low-order point: the "shared" secret
/// would be a value everyone can compute, so the exchange is refused instead of used.
fn shared_secret(secret: &[u8; 32], peer: &[u8; 32]) -> AppResult<[u8; 32]> {
    let secret = x25519_dalek::StaticSecret::from(*secret);
    let peer = x25519_dalek::PublicKey::from(*peer);
    let shared = *secret.diffie_hellman(&peer).as_bytes();
    if shared == [0u8; 32] {
        return Err(AppError::backend("the other device sent an unusable key"));
    }
    Ok(shared)
}

/// Derives the session keys and the six digits.
///
/// @param shared - X25519 result.
/// @param receiver_public - The receiver's one-time public key.
/// @param sender_public - The sender's one-time public key.
/// @param receiver_nonce - The receiver's 16 random bytes.
/// @param sender_nonce - The sender's 16 random bytes.
/// @returns Both directional keys and the digits.
///
/// @remarks
/// The transcript (tag, both keys, both nonces, in a fixed order) is the HKDF salt. That
/// binds the digits to this exact exchange: an attacker relaying between two handshakes
/// ends up with different transcripts on each side and therefore different digits.
fn derive_keys(
    shared: &[u8; 32],
    receiver_public: &[u8; 32],
    sender_public: &[u8; 32],
    receiver_nonce: &[u8; 16],
    sender_nonce: &[u8; 16],
) -> SessionKeys {
    use hkdf::Hkdf;
    use sha2::Sha256;

    let mut transcript = Vec::with_capacity(8 + 32 + 32 + 16 + 16);
    transcript.extend_from_slice(b"stauri-lanpair-v1");
    transcript.extend_from_slice(receiver_public);
    transcript.extend_from_slice(sender_public);
    transcript.extend_from_slice(receiver_nonce);
    transcript.extend_from_slice(sender_nonce);

    let hkdf = Hkdf::<Sha256>::new(Some(&transcript), shared);
    let mut okm = [0u8; 64];
    hkdf.expand(b"stauri-lanpair-keys", &mut okm)
        .expect("64 bytes is within the HKDF limit");
    let mut sender_to_receiver = [0u8; 32];
    let mut receiver_to_sender = [0u8; 32];
    sender_to_receiver.copy_from_slice(&okm[..32]);
    receiver_to_sender.copy_from_slice(&okm[32..]);

    let mut code = [0u8; 4];
    hkdf.expand(b"stauri-lanpair-code", &mut code)
        .expect("4 bytes is within the HKDF limit");
    let value = u32::from_be_bytes(code) % 1_000_000;

    SessionKeys {
        sender_to_receiver,
        receiver_to_sender,
        digits: format!("{value:06}"),
    }
}

/// Seals a frame.
///
/// @returns A 12-byte nonce followed by the AES-256-GCM ciphertext and tag.
fn seal(key: &[u8; 32], plain: &[u8]) -> AppResult<Vec<u8>> {
    use aes_gcm::aead::{Aead, KeyInit};
    use aes_gcm::{Aes256Gcm, Nonce};

    let nonce: [u8; 12] = random()?;
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|_| AppError::internal("invalid session key length"))?;
    let sealed = cipher
        .encrypt(Nonce::from_slice(&nonce), plain)
        .map_err(|_| AppError::internal("sealing a frame failed"))?;
    let mut frame = Vec::with_capacity(12 + sealed.len());
    frame.extend_from_slice(&nonce);
    frame.extend_from_slice(&sealed);
    Ok(frame)
}

/// Opens a frame sealed by the other side.
///
/// @returns The plaintext, or `None` when the frame is short, altered or sealed with a
/// different key.
fn open(key: &[u8; 32], frame: &[u8]) -> Option<Vec<u8>> {
    use aes_gcm::aead::{Aead, KeyInit};
    use aes_gcm::{Aes256Gcm, Nonce};

    if frame.len() < 12 + 16 {
        return None;
    }
    let (nonce, body) = frame.split_at(12);
    let cipher = Aes256Gcm::new_from_slice(key).ok()?;
    cipher.decrypt(Nonce::from_slice(nonce), body).ok()
}

/// Writes one length-prefixed frame.
async fn write_frame(stream: &mut TcpStream, body: &[u8]) -> AppResult<()> {
    let length = u32::try_from(body.len()).map_err(|_| AppError::internal("frame too long"))?;
    stream
        .write_all(&length.to_be_bytes())
        .await
        .map_err(|e| AppError::network(format!("sending to the other device failed: {e}")))?;
    stream
        .write_all(body)
        .await
        .map_err(|e| AppError::network(format!("sending to the other device failed: {e}")))?;
    stream
        .flush()
        .await
        .map_err(|e| AppError::network(format!("sending to the other device failed: {e}")))
}

/// Reads one length-prefixed frame.
async fn read_frame(stream: &mut TcpStream) -> AppResult<Vec<u8>> {
    let mut length = [0u8; 4];
    stream
        .read_exact(&mut length)
        .await
        .map_err(|e| AppError::network(format!("the other device stopped answering: {e}")))?;
    let length = u32::from_be_bytes(length) as usize;
    if length > MAX_FRAME {
        return Err(AppError::network(
            "the other device sent an oversized frame",
        ));
    }
    let mut body = vec![0u8; length];
    stream
        .read_exact(&mut body)
        .await
        .map_err(|e| AppError::network(format!("the other device stopped answering: {e}")))?;
    Ok(body)
}

/// Time left in the attempt.
fn remaining(deadline: Instant) -> AppResult<Duration> {
    let left = deadline.saturating_duration_since(Instant::now());
    if left.is_zero() {
        return Err(AppError::network("pairing timed out"));
    }
    Ok(left)
}

/// Waits for the user to confirm the digits.
async fn wait_for_confirm(confirm: &Notify, deadline: Instant) -> AppResult<()> {
    let wait = remaining(deadline)?;
    tokio::select! {
        // A permit is remembered, so a press during the handshake is not lost.
        () = confirm.notified() => Ok(()),
        () = tokio::time::sleep(wait) => Err(AppError::network("pairing timed out")),
    }
}

/// Parses an answer to a probe.
fn parse_reply(datagram: &[u8]) -> Option<Reply> {
    if datagram.len() != 4 + 32 + 16 + 2 || &datagram[..4] != REPLY_TAG {
        return None;
    }
    let mut public = [0u8; 32];
    public.copy_from_slice(&datagram[4..36]);
    let mut nonce = [0u8; 16];
    nonce.copy_from_slice(&datagram[36..52]);
    let port = u16::from_be_bytes([datagram[52], datagram[53]]);
    if port == 0 {
        return None;
    }
    Some(Reply {
        public,
        nonce,
        port,
    })
}

/// The receiving side: announces itself, then runs the handshake.
///
/// @returns The open stream and the session keys both sides share.
async fn receiver_handshake(
    discovery_port: u16,
    status: &Arc<Mutex<LanStatus>>,
    cancel: &AtomicBool,
    deadline: Instant,
) -> AppResult<(TcpStream, SessionKeys)> {
    let udp = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, discovery_port))
        .await
        .map_err(|e| AppError::network(format!("cannot listen for the other device: {e}")))?;
    let listener = TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0))
        .await
        .map_err(|e| AppError::network(format!("cannot open the handshake port: {e}")))?;
    let port = listener
        .local_addr()
        .map_err(|e| AppError::network(format!("cannot read the handshake port: {e}")))?
        .port();
    crate::core::trace::line(&format!(
        "pairing lan receiver listening udp={discovery_port} tcp={port} local={:?}",
        local_ipv4()
    ));

    let secret: [u8; 32] = random()?;
    let public = public_of(&secret);
    let nonce: [u8; 16] = random()?;

    let mut buffer = [0u8; 128];
    let (mut stream, peer) = loop {
        if cancel.load(Ordering::SeqCst) {
            return Err(AppError::internal("pairing cancelled"));
        }
        let wait = remaining(deadline)?;
        tokio::select! {
            accepted = listener.accept() => {
                break accepted.map_err(|e| AppError::network(format!("accepting the other device failed: {e}")))?;
            }
            datagram = udp.recv_from(&mut buffer) => {
                if let Ok((length, from)) = datagram {
                    if length >= 4 && &buffer[..4] == PROBE_TAG {
                        crate::core::trace::line(&format!("pairing lan probe from {from}"));
                        let mut reply = Vec::with_capacity(54);
                        reply.extend_from_slice(REPLY_TAG);
                        reply.extend_from_slice(&public);
                        reply.extend_from_slice(&nonce);
                        reply.extend_from_slice(&port.to_be_bytes());
                        // A lost answer is not an error: the sender probes again.
                        let _ = udp.send_to(&reply, from).await;
                    }
                }
            }
            () = tokio::time::sleep(wait) => {
                return Err(AppError::network("no other device answered"));
            }
        }
    };

    crate::core::trace::line(&format!("pairing lan peer connected from {peer}"));
    let _ = stream.set_nodelay(true);

    let hello = tokio::time::timeout(STEP_TIMEOUT, read_frame(&mut stream))
        .await
        .map_err(|_| AppError::network("the other device said nothing"))??;
    if hello.len() != 4 + 32 + 16 || &hello[..4] != HELLO_TAG {
        return Err(AppError::network(
            "the other device speaks a different protocol",
        ));
    }
    let mut sender_public = [0u8; 32];
    sender_public.copy_from_slice(&hello[4..36]);
    let mut sender_nonce = [0u8; 16];
    sender_nonce.copy_from_slice(&hello[36..52]);

    let shared = shared_secret(&secret, &sender_public)?;
    let keys = derive_keys(&shared, &public, &sender_public, &nonce, &sender_nonce);
    publish_codes(status, keys.digits.clone());

    Ok((stream, keys))
}

/// The sending side: finds the receiver and runs the handshake.
///
/// @param explicit - Address typed by the user, when the broadcast found nothing. A
///   point-to-point probe is the same exchange; only the destination differs.
async fn sender_handshake(
    discovery_port: u16,
    explicit: Option<Ipv4Addr>,
    cancel: &AtomicBool,
    deadline: Instant,
) -> AppResult<(TcpStream, SessionKeys)> {
    let udp = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))
        .await
        .map_err(|e| AppError::network(format!("cannot search for the other device: {e}")))?;
    udp.set_broadcast(true)
        .map_err(|e| AppError::network(format!("cannot broadcast: {e}")))?;

    // The broadcast address reaches every interface the platform routes it on; the
    // loopback copy is for two instances on one machine, which is how this is tested.
    // An address typed by the user replaces both: some routers and access points drop
    // broadcast while letting unicast through, and a phone on the wrong network is
    // still reachable directly.
    let targets: Vec<SocketAddr> = match explicit {
        Some(address) => vec![SocketAddr::new(IpAddr::V4(address), discovery_port)],
        None => vec![
            SocketAddr::new(IpAddr::V4(Ipv4Addr::BROADCAST), discovery_port),
            SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), discovery_port),
        ],
    };
    crate::core::trace::line(&format!(
        "pairing lan searching targets={:?}",
        targets
            .iter()
            .map(std::string::ToString::to_string)
            .collect::<Vec<_>>()
    ));

    let mut buffer = [0u8; 128];
    let (reply, from) = loop {
        if cancel.load(Ordering::SeqCst) {
            return Err(AppError::internal("pairing cancelled"));
        }
        for target in &targets {
            let _ = udp.send_to(PROBE_TAG, target).await;
        }
        match tokio::time::timeout(PROBE_INTERVAL, udp.recv_from(&mut buffer)).await {
            Ok(Ok((length, from))) => {
                if let Some(reply) = parse_reply(&buffer[..length]) {
                    break (reply, from);
                }
            }
            Ok(Err(e)) => {
                return Err(AppError::network(format!(
                    "searching for the other device failed: {e}"
                )));
            }
            Err(_) => {}
        }
        remaining(deadline)?;
    };

    let address = SocketAddr::new(from.ip(), reply.port);
    crate::core::trace::line(&format!("pairing lan peer announced at {address}"));
    let mut stream = tokio::time::timeout(STEP_TIMEOUT, TcpStream::connect(address))
        .await
        .map_err(|_| AppError::network("the other device did not answer"))?
        .map_err(|e| AppError::network(format!("connecting to the other device failed: {e}")))?;
    let _ = stream.set_nodelay(true);

    let secret: [u8; 32] = random()?;
    let public = public_of(&secret);
    let nonce: [u8; 16] = random()?;

    let mut hello = Vec::with_capacity(52);
    hello.extend_from_slice(HELLO_TAG);
    hello.extend_from_slice(&public);
    hello.extend_from_slice(&nonce);
    tokio::time::timeout(STEP_TIMEOUT, write_frame(&mut stream, &hello))
        .await
        .map_err(|_| AppError::network("the other device did not answer"))??;

    let shared = shared_secret(&secret, &reply.public)?;
    let keys = derive_keys(&shared, &reply.public, &public, &reply.nonce, &nonce);
    Ok((stream, keys))
}

/// Runs the receiving device: announce, handshake, confirm, take the profile in.
async fn receiver_task(
    data_dir: String,
    network: String,
    status: Arc<Mutex<LanStatus>>,
    confirm: Arc<Notify>,
    cancel: Arc<AtomicBool>,
) {
    let deadline = Instant::now() + ATTEMPT_TTL;
    let result = async {
        let (mut stream, keys) =
            receiver_handshake(DISCOVERY_PORT, &status, &cancel, deadline).await?;
        wait_for_confirm(&confirm, deadline).await?;
        set_phase(&status, "transferring");

        let ready = seal(&keys.receiver_to_sender, b"ready")?;
        tokio::time::timeout(STEP_TIMEOUT, write_frame(&mut stream, &ready))
            .await
            .map_err(|_| AppError::network("the other device did not answer"))??;

        let frame = tokio::time::timeout(remaining(deadline)?, read_frame(&mut stream))
            .await
            .map_err(|_| AppError::network("the other device did not send the profile"))??;
        let body = open(&keys.sender_to_receiver, &frame)
            .ok_or_else(|| AppError::network("the other device sent an unreadable answer"))?;
        let connection_string = String::from_utf8(body)
            .map_err(|_| AppError::network("the other device sent an unreadable answer"))?;
        // The addresses in the string are also the names in status-go's certificate, and
        // the client verifies the certificate against the host it dials. Dialling any
        // other address of the same device fails that check inside the challenge request,
        // with no event and no message — which is what turned this into an unexplained
        // "pairing failed". So the check happens here, before status-go is involved.
        let (advertised, port) = crate::core::pairing::addresses(&connection_string);
        crate::core::trace::line(&format!(
            "pairing lan string len={} addresses={advertised:?} port={port:?}",
            connection_string.len()
        ));

        let mut reachable = false;
        if let Some(port) = port {
            for ip in &advertised {
                let target = SocketAddr::new(IpAddr::V4(*ip), port);
                let answered =
                    tokio::time::timeout(Duration::from_millis(800), TcpStream::connect(target))
                        .await
                        .map(|result| result.is_ok())
                        .unwrap_or(false);
                if answered {
                    reachable = true;
                    break;
                }
            }
        }
        if !reachable {
            return Err(AppError::backend(format!(
                "the other device says its address is {:?}, and nothing answers there. \
                 Turn off VPN and mobile data on it, so it advertises the address of the \
                 network both devices share.",
                advertised
            )));
        }

        if !crate::core::pairing::is_valid_connection_string(&connection_string) {
            return Err(AppError::backend(
                "the other device sent an invalid connection code",
            ));
        }

        let account =
            crate::core::pairing::bootstrap_receiver(&data_dir, &connection_string).await?;
        let slot = crate::core::credentials::Slot::new(&network, &account.key_uid)?;
        crate::core::credentials::stash_pending(slot, account.password.clone());
        publish_done(&status, Some(account.key_uid), account.name);
        crate::core::trace::line("pairing lan received account");
        Ok(())
    }
    .await;

    if let Err(e) = result {
        if !cancel.load(Ordering::SeqCst) {
            crate::core::trace::line(&format!("pairing lan receiver failed: {}", e.message));
            fail(&status, e.message);
        }
    }
}

/// Runs the sending device: find, handshake, confirm, issue the string, send the profile.
#[allow(clippy::too_many_arguments)]
async fn sender_task(
    data_dir: String,
    key_uid: String,
    password: String,
    device_type: String,
    sync_messages: bool,
    explicit: Option<Ipv4Addr>,
    status: Arc<Mutex<LanStatus>>,
    confirm: Arc<Notify>,
    cancel: Arc<AtomicBool>,
) {
    let deadline = Instant::now() + ATTEMPT_TTL;
    let result = async {
        let (mut stream, keys) =
            sender_handshake(DISCOVERY_PORT, explicit, &cancel, deadline).await?;
        publish_codes(&status, keys.digits.clone());
        wait_for_confirm(&confirm, deadline).await?;

        // The receiver confirms first: without it the sender would issue a string that
        // nobody has agreed to receive.
        let frame = tokio::time::timeout(remaining(deadline)?, read_frame(&mut stream))
            .await
            .map_err(|_| AppError::network("the other device did not confirm"))??;
        let body = open(&keys.receiver_to_sender, &frame)
            .ok_or_else(|| AppError::network("the other device did not confirm"))?;
        if body != b"ready" {
            return Err(AppError::network("the other device did not confirm"));
        }

        set_phase(&status, "transferring");

        // Subscribed before the server starts: its first event can arrive before the
        // call returns, and a later subscriber would wait for something that happened.
        let mut signals = crate::core::inprocess::subscribe();

        let data = data_dir.clone();
        let key = key_uid.clone();
        let pass = password.clone();
        let device = device_type.clone();
        let (connection_string, _) = tokio::task::spawn_blocking(move || {
            crate::core::pairing::start_sender(&data, &key, &pass, &device, sync_messages)
        })
        .await
        .map_err(|e| AppError::internal(format!("pairing start panicked: {e}")))??;
        crate::core::trace::line(&format!(
            "pairing lan issued len={} {}",
            connection_string.len(),
            crate::core::pairing::describe(&connection_string)
        ));

        let sealed = seal(&keys.sender_to_receiver, connection_string.as_bytes())?;
        tokio::time::timeout(STEP_TIMEOUT, write_frame(&mut stream, &sealed))
            .await
            .map_err(|_| AppError::network("the other device stopped answering"))??;

        crate::core::pairing::wait_for_transfer(&mut signals).await?;
        publish_done(&status, Some(key_uid), None);
        crate::core::trace::line("pairing lan sent account");
        Ok(())
    }
    .await;

    if let Err(e) = result {
        if !cancel.load(Ordering::SeqCst) {
            crate::core::trace::line(&format!("pairing lan sender failed: {}", e.message));
            fail(&status, e.message);
        }
    }
}

/// Starts this device as the receiver.
///
/// @param data_dir - Root data directory of the selected network.
/// @param network - `mainnet` or `testnet`; the received password is filed under it.
/// @returns The initial status, `waiting`.
pub fn start_receiver(data_dir: String, network: String) -> LanStatus {
    let status = Arc::new(Mutex::new(LanStatus {
        phase: "waiting".to_string(),
        ..LanStatus::default()
    }));
    let confirm = Arc::new(Notify::new());
    let cancel = Arc::new(AtomicBool::new(false));
    let task = tokio::spawn(receiver_task(
        data_dir,
        network,
        status.clone(),
        confirm.clone(),
        cancel.clone(),
    ));
    install(status.clone(), confirm, cancel, task);
    snapshot(&status)
}

/// Starts this device as the sender.
///
/// @param data_dir - Root data directory of the selected network.
/// @param key_uid - Profile being sent.
/// @param password - Its password.
/// @param device_type - `android`, `linux`, … as status-go records it.
/// @param sync_messages - Whether the message history travels with the profile.
/// @returns The initial status, `waiting`.
pub fn start_sender_device(
    data_dir: String,
    key_uid: String,
    password: String,
    device_type: String,
    sync_messages: bool,
    explicit: Option<Ipv4Addr>,
) -> LanStatus {
    let status = Arc::new(Mutex::new(LanStatus {
        phase: "waiting".to_string(),
        ..LanStatus::default()
    }));
    let confirm = Arc::new(Notify::new());
    let cancel = Arc::new(AtomicBool::new(false));
    let task = tokio::spawn(sender_task(
        data_dir,
        key_uid,
        password,
        device_type,
        sync_messages,
        explicit,
        status.clone(),
        confirm.clone(),
        cancel.clone(),
    ));
    install(status.clone(), confirm, cancel, task);
    snapshot(&status)
}

/// Presses Sync on this device.
///
/// @returns The status as it is now.
#[must_use]
pub fn confirm() -> LanStatus {
    match &*lock(&RUNNING) {
        Some(running) => {
            running.confirm.notify_one();
            snapshot(&running.status)
        }
        None => idle(),
    }
}

/// Stops the attempt and forgets it.
#[must_use]
pub fn cancel() -> LanStatus {
    stop_running();
    idle()
}

/// The status of the current attempt.
#[must_use]
pub fn status() -> LanStatus {
    match &*lock(&RUNNING) {
        Some(running) => snapshot(&running.status),
        None => idle(),
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Starts the receiving side of a LAN transfer.
#[tauri::command]
pub async fn pairing_lan_receive_start(data_dir: String, network: String) -> LanStatus {
    start_receiver(data_dir, network)
}

/// Starts the sending side of a LAN transfer.
///
/// @param address - Optional address typed by the user, `192.168.1.7`. When it is
///   present the probe goes there directly instead of to the broadcast address.
#[tauri::command]
pub async fn pairing_lan_send_start(
    data_dir: String,
    key_uid: String,
    password: String,
    device_type: String,
    sync_messages: bool,
    address: Option<String>,
) -> AppResult<LanStatus> {
    let explicit = match address.as_deref().map(str::trim) {
        Some(text) if !text.is_empty() => {
            let host = text.split(':').next().unwrap_or(text);
            match host.parse::<Ipv4Addr>() {
                Ok(ip) => Some(ip),
                Err(_) => {
                    return Err(AppError::network("the address must look like 192.168.1.7"));
                }
            }
        }
        _ => None,
    };
    Ok(start_sender_device(
        data_dir,
        key_uid,
        password,
        device_type,
        sync_messages,
        explicit,
    ))
}

/// Address of this device on the local network.
///
/// @returns The IPv4 address of the interface the system would use, or `None` when the
///   device has no network at all.
/// @remarks
/// The routing table is asked which source address it would pick for an outside
/// destination; nothing is sent. That is the address the other device can reach, and it
/// is what the waiting screen shows so the person can type it if the broadcast search
/// finds nothing.
fn local_ipv4() -> Option<Ipv4Addr> {
    let socket = std::net::UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    // A UDP connect transmits nothing; it only fills in the local address.
    socket.connect((Ipv4Addr::new(8, 8, 8, 8), 80)).ok()?;
    match socket.local_addr().ok()?.ip() {
        IpAddr::V4(ip) if !ip.is_loopback() && !ip.is_unspecified() => Some(ip),
        _ => None,
    }
}

/// Address of this device, for the waiting screen.
#[tauri::command]
pub fn pairing_lan_local_address() -> Option<String> {
    local_ipv4().map(|ip| ip.to_string())
}

/// Confirms the six digits on this device.
#[tauri::command]
pub fn pairing_lan_confirm() -> LanStatus {
    confirm()
}

/// Gives up on the transfer.
#[tauri::command]
pub fn pairing_lan_cancel() -> LanStatus {
    cancel()
}

/// Current state of the transfer.
#[tauri::command]
pub fn pairing_lan_status() -> LanStatus {
    status()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys_for(
        shared: [u8; 32],
        r: [u8; 32],
        s: [u8; 32],
        rn: [u8; 16],
        sn: [u8; 16],
    ) -> SessionKeys {
        derive_keys(&shared, &r, &s, &rn, &sn)
    }

    #[test]
    fn both_sides_derive_the_same_digits() {
        let shared = [7u8; 32];
        let r = [1u8; 32];
        let s = [2u8; 32];
        let rn = [3u8; 16];
        let sn = [4u8; 16];
        let a = keys_for(shared, r, s, rn, sn);
        let b = keys_for(shared, r, s, rn, sn);
        assert_eq!(a.digits, b.digits);
        assert_eq!(a.digits.len(), 6);
        assert!(a.digits.chars().all(|c| c.is_ascii_digit()));
        assert_eq!(a.sender_to_receiver, b.sender_to_receiver);
        assert_eq!(a.receiver_to_sender, b.receiver_to_sender);
        assert_ne!(a.sender_to_receiver, a.receiver_to_sender);
    }

    #[test]
    fn a_relayed_exchange_gets_different_digits() {
        // The attacker between two devices runs one handshake with each, so one of the
        // four transcript inputs differs on each side.
        let shared = [7u8; 32];
        let a = keys_for(shared, [1u8; 32], [2u8; 32], [3u8; 16], [4u8; 16]);
        let b = keys_for(shared, [1u8; 32], [9u8; 32], [3u8; 16], [4u8; 16]);
        assert_ne!(a.digits, b.digits);
        let c = keys_for(shared, [1u8; 32], [2u8; 32], [8u8; 16], [4u8; 16]);
        assert_ne!(a.digits, c.digits);
        let d = keys_for([6u8; 32], [1u8; 32], [2u8; 32], [3u8; 16], [4u8; 16]);
        assert_ne!(a.digits, d.digits);
    }

    #[test]
    fn the_transcript_order_matters() {
        // Swapping the two public keys must not produce the same keys: otherwise a
        // reflection of the hello would pass unnoticed.
        let a = keys_for([7u8; 32], [1u8; 32], [2u8; 32], [3u8; 16], [4u8; 16]);
        let b = keys_for([7u8; 32], [2u8; 32], [1u8; 32], [3u8; 16], [4u8; 16]);
        assert_ne!(a.sender_to_receiver, b.sender_to_receiver);
    }

    #[test]
    fn frames_round_trip_and_reject_tampering() {
        let key = [5u8; 32];
        let sealed = seal(&key, b"cs3:abc").expect("seal");
        assert_eq!(open(&key, &sealed), Some(b"cs3:abc".to_vec()));

        let mut altered = sealed.clone();
        let last = altered.len() - 1;
        altered[last] ^= 0x01;
        assert_eq!(open(&key, &altered), None);

        assert_eq!(open(&[6u8; 32], &sealed), None);
        assert_eq!(open(&key, &[]), None);
        assert_eq!(open(&key, &[0u8; 20]), None);
    }

    #[test]
    fn two_seals_of_the_same_plaintext_differ() {
        // Random nonces: equal frames would leak that a frame was repeated.
        let key = [5u8; 32];
        let a = seal(&key, b"ready").expect("seal");
        let b = seal(&key, b"ready").expect("seal");
        assert_ne!(a, b);
    }

    #[test]
    fn zero_shared_secret_is_refused() {
        // An all-zero public key is the identity point: the "shared" secret would be
        // zero for every secret, so anyone could compute the session keys.
        assert!(shared_secret(&[1u8; 32], &[0u8; 32]).is_err());
        // A real key is still accepted.
        let secret = [1u8; 32];
        let peer = public_of(&[2u8; 32]);
        assert!(shared_secret(&secret, &peer).is_ok());
    }

    #[test]
    fn probe_answers_are_parsed_and_junk_is_not() {
        let mut datagram = Vec::new();
        datagram.extend_from_slice(REPLY_TAG);
        datagram.extend_from_slice(&[9u8; 32]);
        datagram.extend_from_slice(&[7u8; 16]);
        datagram.extend_from_slice(&47899u16.to_be_bytes());
        let reply = parse_reply(&datagram).expect("a valid answer");
        assert_eq!(reply.public, [9u8; 32]);
        assert_eq!(reply.nonce, [7u8; 16]);
        assert_eq!(reply.port, 47899);

        assert!(parse_reply(b"STP1").is_none());
        assert!(parse_reply(&[0u8; 54]).is_none());
        let mut no_port = datagram.clone();
        no_port[52] = 0;
        no_port[53] = 0;
        assert!(parse_reply(&no_port).is_none());
    }

    #[tokio::test]
    async fn two_devices_in_one_process_agree_on_the_digits() {
        // The discovery port is passed in so the test never fights a real attempt on the
        // machine, and the loopback copy of the probe reaches the receiver.
        let port = 47890;
        let status_r = Arc::new(Mutex::new(LanStatus {
            phase: "waiting".to_string(),
            ..LanStatus::default()
        }));
        let cancel = AtomicBool::new(false);
        let deadline = Instant::now() + Duration::from_secs(10);

        let (receiver_result, sender_result) = tokio::join!(
            receiver_handshake(port, &status_r, &cancel, deadline),
            sender_handshake(port, None, &cancel, deadline),
        );
        let (mut receiver_stream, receiver_keys) = receiver_result.expect("receiver");
        let (mut sender_stream, sender_keys) = sender_result.expect("sender");

        // The receiver derives from the announcement; the sender from the hello. They
        // must still agree, which is the whole point of the comparison screen.
        assert_eq!(sender_keys.digits, receiver_keys.digits);
        assert_eq!(
            sender_keys.sender_to_receiver,
            receiver_keys.sender_to_receiver
        );
        assert_eq!(
            receiver_keys.digits,
            lock(&status_r).digits.clone().unwrap()
        );

        // Finish the exchange the way the screens do, to prove the frames flow.
        let ready = seal(&receiver_keys.receiver_to_sender, b"ready").expect("seal");
        write_frame(&mut receiver_stream, &ready)
            .await
            .expect("send ready");
        let frame = read_frame(&mut sender_stream).await.expect("read ready");
        assert_eq!(
            open(&sender_keys.receiver_to_sender, &frame),
            Some(b"ready".to_vec())
        );

        let sealed = seal(&sender_keys.sender_to_receiver, b"cs3:x:y").expect("seal");
        write_frame(&mut sender_stream, &sealed)
            .await
            .expect("send string");
        let frame = read_frame(&mut receiver_stream).await.expect("read string");
        assert_eq!(
            open(&receiver_keys.sender_to_receiver, &frame),
            Some(b"cs3:x:y".to_vec())
        );
    }
}
