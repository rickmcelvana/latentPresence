fn main() {
    // P8-T05: the tray's menu needs Common Controls 6. tauri-build declares it in a manifest it
    // puts in the app's resources — in the binary only — and a unit-test binary without it links
    // the tray and dies before main with STATUS_ENTRYPOINT_NOT_FOUND (0xc0000139, 2026-10-19).
    // Cargo has no link argument for a library's own tests, so the linker embeds the same manifest
    // (tauri-build's `windows-app-manifest.xml`, copied) into everything, and tauri-build adds none.
    let msvc = std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc");
    let mut attributes = tauri_build::Attributes::new();
    if msvc {
        attributes = attributes
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
        let manifest = std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap())
            .join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    }
    tauri_build::try_build(attributes).expect("the Tauri build script failed");
}
