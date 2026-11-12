//! Android: status-go как библиотека `libstatus.so` внутри процесса приложения.
//!
//! На десктопе бэкенд — отдельный процесс (sidecar), на Android процесса быть
//! не может. Здесь библиотека загружается через `dlopen` и её C-функции
//! вызываются напрямую. См. `docs/PLAN.md`, раздел B.2.
//!
//! Модуль только под Android. Весь вызов status-go идёт через
//! [`InProcessBackend::call_rpc`], ошибки приходят строкой JSON, как в
//! `mobile/status.go` (`CallRPC` возвращает JSON-строку).

use std::ffi::{CStr, CString};
use std::os::raw::c_char;
use std::sync::OnceLock;

use libloading::{Library, Symbol};
use serde_json::Value;

use crate::error::{AppError, AppResult};

/// Сигнатуры из `mobile/status.go`: строка на вход, строка на выход.
type CStrFn = unsafe extern "C" fn(*mut c_char) -> *mut c_char;

// `free` из libc: строку от cgo освобождает вызывающий (`libstatus.h` не
// экспортирует отдельной функции освобождения).
unsafe extern "C" {
    fn free(ptr: *mut std::ffi::c_void);
}

/// Загруженная `libstatus.so` и её функции.
///
/// `Library` держим в структуре: пока он жив, символы действительны.
pub struct InProcessBackend {
    _lib: Library,
    call_rpc: CStrFn,
    initialize: CStrFn,
    login: CStrFn,
    call_rpc_raw: CStrFn,
    create_and_login: CStrFn,
    logout: unsafe extern "C" fn() -> *mut c_char,
}

// Указатели на функции и `Library` потокобезопасны: status-go сам
// сериализует вызовы внутри себя.
unsafe impl Send for InProcessBackend {}
unsafe impl Sync for InProcessBackend {}

static BACKEND: OnceLock<AppResult<InProcessBackend>> = OnceLock::new();

impl InProcessBackend {
    /// Загружает `libstatus.so` из нативных библиотек приложения.
    ///
    /// Имя `libstatus.so` Android берёт из `jniLibs/arm64-v8a`, так что
    /// достаточно короткого имени: загрузчик найдёт его в путях приложения.
    fn load() -> AppResult<Self> {
        // SAFETY: загрузка доверенной библиотеки, которую собрали сами
 // (build/bin/libstatus.so из status-go, см. docs/PLAN.md, B.0).
        let lib = unsafe { Library::new("libstatus.so") }
            .map_err(|e| AppError::internal(format!("cannot load libstatus.so: {e}")))?;

        // SAFETY: имена и сигнатуры из mobile/status.go.
 unsafe {
     let call_rpc: Symbol<CStrFn> = lib
         .get(b"CallRPC\0")
  .map_err(|e| AppError::internal(format!("no CallRPC: {e}")))?;
     let initialize: Symbol<CStrFn> = lib
  .get(b"InitializeApplication\0")
         .map_err(|e| AppError::internal(format!("no InitializeApplication: {e}")))?;
            let call_rpc_raw: Symbol<CStrFn> = lib
         .get(b"CallRPC\0")
         .map_err(|e| AppError::internal(format!("no CallRPC raw: {e}")))?;
        let login: Symbol<CStrFn> = lib
         .get(b"LoginAccount\0")
  .map_err(|e| AppError::internal(format!("no LoginAccount: {e}")))?;

     let create_and_login: Symbol<CStrFn> = lib
         .get(b"CreateAccountAndLogin\0")
         .map_err(|e| AppError::internal(format!("no CreateAccountAndLogin: {e}")))?;
     let logout: Symbol<unsafe extern "C" fn() -> *mut c_char> = lib
  .get(b"Logout\0")
         .map_err(|e| AppError::internal(format!("no Logout: {e}")))?;
     Ok(Self {
         call_rpc: *call_rpc,
  initialize: *initialize,
  login: *login,
  call_rpc_raw: *call_rpc_raw,
  create_and_login: *create_and_login,
  logout: *logout,
         _lib: lib,
     })
        }
    }

    /// Вызывает C-функцию со строкой JSON и возвращает ответ строкой.
    ///
    /// Ответ выделяет Go (cgo), освобождаем его `free` из libc. Аргумент
    /// принадлежит нам: отдаём указатель и забираем его обратно, чтобы
    /// освободить строку.
    fn invoke(&self, f: CStrFn, json: &str) -> AppResult<String> {
 let input = CString::new(json)
     .map_err(|_| AppError::internal("request contains a NUL byte"))?;
 let raw = input.into_raw();
 // SAFETY: raw — наша C-строка до вызова.
        let out = unsafe { f(raw) };
        // SAFETY: raw возвращаем в CString и освобождаем один раз.
        drop(unsafe { CString::from_raw(raw) });
 if out.is_null() {
     return Err(AppError::backend("status-go returned no response"));
 }
        // SAFETY: out — C-строка, которую вернул status-go.
        let text = unsafe { CStr::from_ptr(out) }.to_string_lossy().into_owned();
 // SAFETY: out больше не используем после копирования.
        unsafe { free(out as *mut std::ffi::c_void) };
        Ok(text)
    }

    /// Инициализация приложения (`InitializeApplication`), один раз при старте.
    pub fn initialize(&self, request_json: &str) -> AppResult<String> {
        self.invoke(self.initialize, request_json)
    }

    /// Вход в аккаунт (`LoginAccount`).
    pub fn login(&self, request_json: &str) -> AppResult<String> {
        self.invoke(self.login, request_json)
    }

    /// Прямой эндпоинт status-go по имени (то же, что `statusFetch(port, endpoint, body)`).
    /// `Logout` не принимает аргументов, остальные — одну строку JSON.
    pub fn direct(&self, endpoint: &str, body_json: &str) -> AppResult<String> {
        match endpoint {
     "InitializeApplication" => self.invoke(self.initialize, body_json),
     "LoginAccount" => self.invoke(self.login, body_json),
     "CreateAccountAndLogin" => self.invoke(self.create_and_login, body_json),
     "Logout" => {
         // SAFETY: Logout не принимает аргументов, возвращает C-строку от Go.
  let out = unsafe { (self.logout)() };
         if out.is_null() {
      return Err(AppError::backend("status-go returned no response"));
  }
  // SAFETY: out — C-строка от status-go, копируем и освобождаем.
  let text = unsafe { CStr::from_ptr(out) }.to_string_lossy().into_owned();
         unsafe { free(out as *mut std::ffi::c_void) };
         Ok(text)
     }
     "CallRPC" => self.invoke(self.call_rpc_raw, body_json),
     other => Err(AppError::internal(format!("unsupported in-process endpoint: {other}"))),
        }
    }

    /// JSON-RPC вызов (`CallRPC`). Ответ разбираем, ошибки бэкенда поднимаем.
    pub fn call_rpc(&self, method: &str, params: Value) -> AppResult<Value> {
 let request = serde_json::json!({
     "jsonrpc": "2.0",
     "id": 1,
     "method": method,
            "params": params,
 });
        let text = self.invoke(self.call_rpc, &request.to_string())?;
 let envelope: Value = serde_json::from_str(&text)
     .map_err(|e| AppError::backend(format!("invalid JSON from backend: {e}")))?;
        if let Some(err) = envelope.get("error") {
            return Err(AppError::backend(crate::backend_rpc::describe_rpc_error(err)));
 }
        Ok(envelope.get("result").cloned().unwrap_or(Value::Null))
    }
}

/// Один экземпляр на процесс: `libstatus.so` грузится при первом обращении.
pub fn backend() -> AppResult<&'static InProcessBackend> {
    BACKEND
        .get_or_init(InProcessBackend::load)
        .as_ref()
 .map_err(|e| AppError::internal(format!("{e}")))
}
