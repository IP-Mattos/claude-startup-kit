fn main() {
    // Re-run the build script when any icon asset changes so a new icon.ico
    // is re-embedded into the .exe without `cargo clean`. tauri-build does NOT
    // track these by default.
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/icon.icns");
    println!("cargo:rerun-if-changed=icons/icon.png");
    println!("cargo:rerun-if-changed=icons/32x32.png");
    println!("cargo:rerun-if-changed=icons/128x128.png");
    println!("cargo:rerun-if-changed=icons/128x128@2x.png");
    println!("cargo:rerun-if-changed=tauri.conf.json");

    tauri_build::build()
}
