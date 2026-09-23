fn main() {
    for lib in ["libva", "libva-drm", "vpl"] {
        pkg_config::probe_library(lib).unwrap_or_else(|e| panic!("{lib}: {e}"));
    }
    let bindings = bindgen::Builder::default()
        .header_contents("gpu.h", "#include <va/va.h>\n#include <va/va_drm.h>\n#include <va/va_drmcommon.h>\n#include <va/va_vpp.h>\n#include <vpl/mfx.h>\n#include <vpl/mfxdispatcher.h>\n")
        .allowlist_function("(va|MFX).*")
        .allowlist_type("(VA|mfx|_mfx).*")
        .allowlist_var("(VA|MFX)_.*")
        .derive_default(true)
        .generate_comments(false)
        .generate()
        .expect("generate libva/oneVPL bindings");
    bindings
        .write_to_file(std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("gpu.rs"))
        .unwrap();
}
