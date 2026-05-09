fn main() {
    tauri_build::build();

    // sherpa-onnx 静态库需要额外的 Windows 系统库
    #[cfg(target_os = "windows")]
    {
        println!("cargo:rustc-link-lib=advapi32");
    }
}
