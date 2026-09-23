use std::ffi::{CStr, c_char, c_int, c_void};
use glib::translate::ToGlibPtr;
use webkit2gtk::WebViewExt;

pub fn enable_worker_webgl(webview: &webkit2gtk::WebView) {
    let Some(settings) = webview.settings() else { return; };
    // Resolve the public feature API at runtime: older supported WebKitGTK versions lack it.
    // AllowWebGLInWorkers is a stable WebKit feature; keeping it disabled forces CPU previews.
    unsafe {
        let symbols = [
            c"webkit_settings_get_all_features", c"webkit_feature_list_get_length",
            c"webkit_feature_list_get", c"webkit_feature_get_identifier",
            c"webkit_settings_set_feature_enabled", c"webkit_feature_list_unref",
        ].map(|name| libc::dlsym(libc::RTLD_DEFAULT, name.as_ptr()));
        if symbols.iter().any(|symbol| symbol.is_null()) { return; }
        let all: unsafe extern "C" fn() -> *mut c_void = std::mem::transmute(symbols[0]);
        let len: unsafe extern "C" fn(*mut c_void) -> usize = std::mem::transmute(symbols[1]);
        let get: unsafe extern "C" fn(*mut c_void, usize) -> *mut c_void = std::mem::transmute(symbols[2]);
        let identifier: unsafe extern "C" fn(*mut c_void) -> *const c_char = std::mem::transmute(symbols[3]);
        let enable: unsafe extern "C" fn(*mut webkit2gtk::ffi::WebKitSettings, *mut c_void, c_int) = std::mem::transmute(symbols[4]);
        let release: unsafe extern "C" fn(*mut c_void) = std::mem::transmute(symbols[5]);
        let features = all();
        if features.is_null() { return; }
        for index in 0..len(features) {
            let feature = get(features, index);
            if feature.is_null() { continue; }
            let name = identifier(feature);
            if !name.is_null() && CStr::from_ptr(name) == c"AllowWebGLInWorkers" {
                enable(settings.to_glib_none().0, feature, 1);
                break;
            }
        }
        release(features);
    }
}
