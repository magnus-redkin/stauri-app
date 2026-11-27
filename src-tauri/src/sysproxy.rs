//! System proxy discovery for outbound HTTP clients.
//!
//! `reqwest` reads `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` from the environment,
//! and only from there. A desktop application started from a session menu does
//! not inherit them: the proxy is configured in the desktop settings. On a
//! network that requires the proxy, such a request goes direct and stalls
//! mid-body — the feed client reported it as
//! `body read error: error decoding response body`.
//!
//! The module returns a manual HTTP proxy from the platform settings. `None`
//! means "nothing to add": either the environment already carries a proxy
//! (reqwest handles it) or no manual proxy is configured. A PAC file and SOCKS
//! are out of scope; SOCKS would need reqwest's `socks` feature.

use std::sync::OnceLock;

/// Proxy for outbound HTTP clients, discovered once per process.
///
/// # Returns
/// An `http://host:port` URL, or `None` when the environment or the desktop
/// settings do not define one.
///
/// # Remarks
/// An explicit environment proxy always wins: in that case the function returns
/// `None` and reqwest applies the environment itself. The result is cached, so
/// changing the desktop proxy requires a restart — a deliberate cost of not
/// spawning `gsettings`/`reg` for every feed refresh.
pub fn proxy_url() -> Option<String> {
    static CACHE: OnceLock<Option<String>> = OnceLock::new();
    CACHE.get_or_init(detect).clone()
}

fn detect() -> Option<String> {
    if env_proxy_set() {
        return None;
    }
    #[cfg(target_os = "linux")]
    {
        return gnome_proxy();
    }
    #[cfg(target_os = "windows")]
    {
        return windows_proxy();
    }
    #[allow(unreachable_code)]
    None
}

fn env_proxy_set() -> bool {
    [
        "HTTPS_PROXY",
        "https_proxy",
        "HTTP_PROXY",
        "http_proxy",
        "ALL_PROXY",
        "all_proxy",
    ]
    .iter()
    .any(|key| {
        std::env::var_os(key).is_some_and(|value| !value.is_empty())
    })
}

/// Strips the quotes `gsettings` puts around strings (`'127.0.0.1'`).
fn unquote(value: &str) -> String {
    let trimmed = value.trim();
    trimmed
        .strip_prefix('\'')
        .and_then(|v| v.strip_suffix('\''))
        .or_else(|| {
            trimmed
                .strip_prefix('"')
                .and_then(|v| v.strip_suffix('"'))
        })
        .unwrap_or(trimmed)
        .to_string()
}

#[cfg(target_os = "linux")]
fn gsettings(args: &[&str]) -> Option<String> {
    let output = std::process::Command::new("gsettings")
        .args(args)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Manual GNOME proxy: the HTTPS entry, then the HTTP one.
#[cfg(target_os = "linux")]
fn gnome_proxy() -> Option<String> {
    let mode = gsettings(&["get", "org.gnome.system.proxy", "mode"])?;
    if unquote(&mode) != "manual" {
        return None;
    }
    for schema in [
        "org.gnome.system.proxy.https",
        "org.gnome.system.proxy.http",
    ] {
        let host = gsettings(&["get", schema, "host"])
            .map(|value| unquote(&value))
            .unwrap_or_default();
        if host.is_empty() {
            continue;
        }
        let port = gsettings(&["get", schema, "port"])
            .map(|value| value.trim().to_string())
            .unwrap_or_default();
        let Some(port) = port.parse::<u16>().ok().filter(|p| *p > 0) else {
            continue;
        };
        return Some(format!("http://{host}:{port}"));
    }
    None
}

#[cfg(target_os = "windows")]
fn reg_query(name: &str) -> Option<String> {
    let output = std::process::Command::new("reg")
        .args([
            "query",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings",
            "/v",
            name,
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    // The value line is `    ProxyEnable    REG_DWORD    0x1`.
    text.lines()
        .find(|line| line.contains(name))
        .and_then(|line| line.split_whitespace().last())
        .map(str::to_string)
}

/// WinINET proxy, when enabled.
#[cfg(target_os = "windows")]
fn windows_proxy() -> Option<String> {
    let enabled = reg_query("ProxyEnable")?;
    if enabled.trim() != "0x1" && enabled.trim() != "1" {
        return None;
    }
    parse_windows_proxy(&reg_query("ProxyServer")?)
}

/// Parses the `ProxyServer` value: `host:port` or `http=host:port;https=…`.
///
/// Kept platform-independent so it can be tested anywhere. Only HTTP and HTTPS
/// entries are used; a SOCKS entry is ignored because the client has no SOCKS
/// support compiled in.
#[cfg(any(target_os = "windows", test))]
fn parse_windows_proxy(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    if value.contains('=') {
        for scheme in ["https", "http"] {
            let prefix = format!("{scheme}=");
            for part in value.split(';') {
                let Some(address) = part.trim().strip_prefix(&prefix) else {
                    continue;
                };
                let address = address.trim();
                if !address.is_empty() {
                    return Some(format!("http://{address}"));
                }
            }
        }
        return None;
    }
    // A bare `host:port` is the common case.
    value.contains(':').then(|| format!("http://{value}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unquote_removes_single_quotes() {
        assert_eq!(unquote("'127.0.0.1'"), "127.0.0.1");
        assert_eq!(unquote("\"proxy\""), "proxy");
        assert_eq!(unquote("manual"), "manual");
    }

    #[test]
    fn windows_proxy_takes_a_bare_host_port() {
        assert_eq!(
            parse_windows_proxy("127.0.0.1:12334"),
            Some("http://127.0.0.1:12334".into())
        );
    }

    #[test]
    fn windows_proxy_takes_the_http_entry_from_a_scheme_list() {
        assert_eq!(
            parse_windows_proxy("socks=127.0.0.1:1080;http=proxy:8080;https=proxy:8443"),
            Some("http://proxy:8443".into())
        );
    }

    #[test]
    fn windows_proxy_ignores_a_socks_only_list() {
        assert_eq!(parse_windows_proxy("socks=127.0.0.1:1080"), None);
        assert_eq!(parse_windows_proxy(""), None);
    }
}
