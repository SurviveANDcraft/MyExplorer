use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    build_mx();
    tauri_build::build()
}

/// Builds the `mx` agent CLI (../mx, dependency-free) and stages it at bin/mx.exe, where
/// tauri.conf.json bundles it into the installer next to the app.
fn build_mx() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let src = manifest.join("..").join("mx");
    println!("cargo:rerun-if-changed=../mx/src");
    println!("cargo:rerun-if-changed=../mx/Cargo.toml");
    println!("cargo:rerun-if-changed=bin/mx.exe");
    // Own target dir under OUT_DIR: outside the synced project folder, and no lock contention
    // with the outer build.
    let target = PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("mx-target");
    let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
    let mut cmd = Command::new(cargo);
    cmd.args(["build", "--release", "--offline", "--manifest-path"])
        .arg(src.join("Cargo.toml"))
        .arg("--target-dir")
        .arg(&target);
    for (k, _) in std::env::vars_os() {
        let k = k.to_string_lossy().into_owned();
        // Outer-build settings that must not leak into the nested build.
        if k == "CARGO_TARGET_DIR" || k == "CARGO_MAKEFLAGS" || k == "CARGO_BUILD_TARGET" || k.starts_with("CARGO_PROFILE_") {
            cmd.env_remove(&k);
        }
    }
    let status = cmd.status().expect("failed to run cargo for mx");
    assert!(status.success(), "building mx (../mx) failed");
    let built = target.join("release").join("mx.exe");
    let staged = manifest.join("bin").join("mx.exe");
    std::fs::create_dir_all(staged.parent().unwrap()).unwrap();
    if !same(&built, &staged) {
        std::fs::copy(&built, &staged).expect("failed to stage bin/mx.exe");
    }
}

fn same(a: &Path, b: &Path) -> bool {
    match (std::fs::read(a), std::fs::read(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => false,
    }
}
