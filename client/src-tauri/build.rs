use std::path::{Path, PathBuf};

fn main() {
    // 必须在 tauri_build::build() 之前：tauri.windows.conf.json 里把 transcribe-libs/*
    // 声明成打包资源，而 tauri_build 在构建期就会校验这个 glob 能不能匹配到文件。
    // 目录是这一步生成的，顺序反了会报
    // "glob pattern transcribe-libs/* path not found or didn't match any files"。
    stage_transcribe_runtime_libs();
    link_clang_runtime_on_macos();

    tauri_build::build();
}

/// macOS：链接 clang 运行时库 `libclang_rt.osx.a`。
///
/// transcribe-cpp 里的 ggml-metal 用了 `@available(macOS 15.0, *)` 这类运行时版本判断。
/// 部署目标低于 15（我们是 14.0）时，编译器把它编成对 `___isPlatformVersionAtLeast` 的调用，
/// 这个符号在 clang 的运行时库里；rustc 链接时带 `-nodefaultlibs`，不会自动链上它，
/// 结果就是 `Undefined symbols: ___isPlatformVersionAtLeast`。
/// 库的位置向 clang 要（`--print-resource-dir`），Command Line Tools 和完整 Xcode 都适用。
fn link_clang_runtime_on_macos() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    let resource_dir = std::process::Command::new("clang")
        .arg("--print-resource-dir")
        .output()
        .ok()
        .filter(|out| out.status.success())
        .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string());
    let Some(resource_dir) = resource_dir else {
        println!("cargo:warning=没找到 clang，无法链接 libclang_rt.osx.a（可能报 ___isPlatformVersionAtLeast 未定义）");
        return;
    };
    let lib_dir = Path::new(&resource_dir).join("lib").join("darwin");
    if !lib_dir.join("libclang_rt.osx.a").is_file() {
        println!("cargo:warning={} 里没有 libclang_rt.osx.a", lib_dir.display());
        return;
    }
    println!("cargo:rustc-link-search=native={}", lib_dir.display());
    println!("cargo:rustc-link-lib=clang_rt.osx");
}

/// 把 transcribe-cpp 的运行时库 + ggml 后端模块放到两个地方：
///
/// 1. `target/<profile>/` —— 挨着 dev/release 可执行文件，`cargo tauri dev` 和直接
///    跑 exe 时 `init_backends_default()` 才找得到模块。找不到的话注册 0 个设备，
///    加载 GGUF 模型直接报 TRANSCRIBE_ERR_BACKEND。
/// 2. `transcribe-libs/` —— 给 tauri 打包器当资源用（tauri.windows.conf.json 里映射到 exe
///    同级目录），这样安装出来的应用也带着这些 DLL。
///
/// 静态构建（没开 dynamic-backends/shared）时 `DEP_TRANSCRIBE_CPP_*` 不存在，
/// 整个函数是 no-op。
fn stage_transcribe_runtime_libs() {
    println!("cargo:rerun-if-env-changed=DEP_TRANSCRIBE_CPP_RUNTIME_DIR");
    println!("cargo:rerun-if-env-changed=DEP_TRANSCRIBE_CPP_MODULE_DIR");

    let Some(runtime_dir) = std::env::var_os("DEP_TRANSCRIBE_CPP_RUNTIME_DIR") else {
        return; // 静态链接，没有要分发的东西
    };

    // RUNTIME_DIR = 核心库（transcribe + ggml-base），MODULE_DIR = dlopen 的后端模块。
    // 两个可能是同一个目录，去重。
    let mut dirs = vec![PathBuf::from(runtime_dir)];
    if let Some(module_dir) = std::env::var_os("DEP_TRANSCRIBE_CPP_MODULE_DIR") {
        let p = PathBuf::from(module_dir);
        if !dirs.contains(&p) {
            dirs.push(p);
        }
    }

    // OUT_DIR = target/<profile>/build/<pkg>-<hash>/out → 上溯三层 = target/<profile>
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR"));
    let profile_dir = out_dir
        .ancestors()
        .nth(3)
        .expect("OUT_DIR 形状变了")
        .to_path_buf();

    let staging = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap()).join("transcribe-libs");
    // 重建 staging，避免上次构建遗留的、这次已经改名/删掉的模块被一起打包。
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).expect("创建 transcribe-libs 目录");

    let mut copied = 0usize;
    for dir in &dirs {
        println!("cargo:rerun-if-changed={}", dir.display());
        let Ok(entries) = std::fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let src = entry.path();
            let name = match src.file_name().and_then(|s| s.to_str()) {
                Some(n) if n.ends_with(".dll") => n.to_string(),
                _ => continue,
            };
            copy_to(&src, &profile_dir, &name);
            copy_to(&src, &staging, &name);
            copied += 1;
        }
    }

    if copied == 0 {
        panic!(
            "transcribe-cpp 是 shared/dynamic-backends 构建，但在 {dirs:?} 里没找到任何 DLL；\
             这样打出来的包会注册 0 个计算设备、本地 GGUF 模型加载必失败"
        );
    }
    println!("cargo:warning=staged {copied} transcribe/ggml DLL(s)");

    // 上面这些 DLL 是 C++ 编的，加载期就要 VC++ 运行库，必须一起分发。见下面注释。
    let crt = stage_vc_redist(&profile_dir, &staging);
    println!("cargo:warning=staged {crt} VC++ runtime DLL(s)");
}

fn copy_to(src: &Path, dir: &Path, name: &str) {
    if let Err(e) = std::fs::copy(src, dir.join(name)) {
        // 目标被占用（应用正在运行）时不要炸构建，只提示。
        println!("cargo:warning=copy {name} -> {} failed: {e}", dir.display());
    }
}

/// 把 VC++ 运行库（MSVCP140 / VCRUNTIME140 / VCRUNTIME140_1 …）拷到 exe 同级，
/// 跟着安装包一起分发。返回拷了几个。
///
/// 为什么非做不可（0.1.4 真砸过一台机器）：
/// 上面那些 transcribe/ggml DLL 是 C++ 编的，**加载期**就依赖 MSVCP140.dll。
/// 微软的规则是「机器上的运行库版本不得低于编译时的 MSVC 工具集版本」，
/// 反方向不保证兼容。我们用 14.44 编，某台 Win10 上是 2019 年的 14.24：
/// DLL 能加载，但第一次 std::mutex::lock() 直接访问违例（0xc0000005）。
/// 崩点在 init_backends()，那时窗口还没创建、日志刚写两行 ——
/// 用户看到的就是「双击没任何反应，也没有任何报错」。
///
/// 为什么用 app-local 而不是让安装包去装 vc_redist：
/// exe 所在目录在 DLL 搜索顺序里排在 System32 前面，同目录放一份新的就会优先命中；
/// 而且我们是 currentUser 免提权安装，本来就没法跑需要管理员的 vc_redist。
/// 这也是 Handy 的做法（它在 CI 里算好目录塞给 build.rs，我们直接在这儿自己找）。
fn stage_vc_redist(profile_dir: &Path, staging: &Path) -> usize {
    println!("cargo:rerun-if-env-changed=SAYIT_VC_REDIST_DIRS");
    println!("cargo:rerun-if-env-changed=SAYIT_SKIP_VC_REDIST");
    println!("cargo:rerun-if-env-changed=VCToolsRedistDir");

    // 只有 MSVC 目标才有这套运行库
    if std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default() != "msvc" {
        return 0;
    }
    if std::env::var_os("SAYIT_SKIP_VC_REDIST").is_some() {
        println!(
            "cargo:warning=SAYIT_SKIP_VC_REDIST 已设置：不随附 VC++ 运行库。\
             这样打出来的包在运行库比构建工具集旧的机器上会启动即崩，别拿去发版。"
        );
        return 0;
    }

    let dirs = resolve_vc_redist_dirs().unwrap_or_else(|| {
        panic!(
            "找不到 VC++ 运行库 redist 目录，无法把 MSVCP140/VCRUNTIME140 随应用分发。\n\
             不带这几个 DLL 打出来的包，在运行库版本低于构建工具集的机器上会在 \
             init_backends() 里访问违例崩掉（0xc0000005，无窗口、无报错、日志只有开头两行）。\n\
             解决其一：\n\
               1. VS Installer 里装上「MSVC v143 - VS 2022 C++ x64/x86 生成工具（最新）」，\
                  它带 VC\\Redist\\MSVC\\<ver>\\x64\\Microsoft.VC143.CRT；\n\
               2. 手动指定 SAYIT_VC_REDIST_DIRS=<CRT 目录>[;<OpenMP 目录>]；\n\
               3. 明确要打不带运行库的包（只在本机自测）：SAYIT_SKIP_VC_REDIST=1。"
        )
    });

    let mut copied = 0usize;
    for dir in &dirs {
        println!("cargo:rerun-if-changed={}", dir.display());
        let Ok(entries) = std::fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let src = entry.path();
            let name = match src.file_name().and_then(|s| s.to_str()) {
                Some(n) if n.to_ascii_lowercase().ends_with(".dll") => n.to_string(),
                _ => continue,
            };
            copy_to(&src, profile_dir, &name);
            copy_to(&src, staging, &name);
            copied += 1;
        }
    }

    if copied == 0 {
        panic!("VC++ redist 目录 {dirs:?} 里一个 DLL 都没有，装的 VS 组件可能不完整");
    }
    copied
}

/// 定位要随附的运行库目录。优先级：显式指定 → VS 开发环境变量 → vswhere 现查。
///
/// 关键是**取和编译这些 DLL 的同一套 VS 的 redist**，不能随便拿个新版本或
/// System32 里的凑数：System32 里那份正是用户机器上可能过旧的东西，
/// 而版本必须 >= 构建工具集。
fn resolve_vc_redist_dirs() -> Option<Vec<PathBuf>> {
    // 1. 显式指定（分号分隔），给 CI / 特殊构建环境留的口子
    if let Some(v) = std::env::var_os("SAYIT_VC_REDIST_DIRS") {
        let list: Vec<PathBuf> = v
            .to_string_lossy()
            .split(';')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .filter(|p| p.is_dir())
            .collect();
        if !list.is_empty() {
            return Some(list);
        }
    }

    let redist_root = vc_redist_root()?;
    // 我们只出 x64，但别把 arch 写死，将来上 ARM64 不用再回来改。
    let arch = match std::env::var("CARGO_CFG_TARGET_ARCH")
        .unwrap_or_default()
        .as_str()
    {
        "aarch64" => "arm64",
        "x86" => "x86",
        _ => "x64",
    };
    let arch_dir = redist_root.join(arch);

    // 目录名带 VC 代次（Microsoft.VC143.CRT），按名字排序取最新的，
    // 免得工具链升代（VC144…）后这里失配。
    let crt = newest_redist_subdir(&arch_dir, ".crt")?;
    let mut dirs = vec![crt];
    // OpenMP（vcomp140.dll）：当前构建的 ggml 没开 OpenMP，import 表里也没有它。
    // 但 transcribe-cpp-sys 在 Windows 上是「倾向开 OpenMP」的，将来升版本一旦
    // 翻回 ON，缺 vcomp140 又是一次启动即崩。有就带上，多 200KB 买个保险。
    if let Some(omp) = newest_redist_subdir(&arch_dir, ".openmp") {
        dirs.push(omp);
    }
    Some(dirs)
}

/// `VC\Redist\MSVC\<version>` 的绝对路径。
fn vc_redist_root() -> Option<PathBuf> {
    // VS 开发者命令行里会设这个，直接指向 VC\Redist\MSVC\<ver>\
    if let Some(v) = std::env::var_os("VCToolsRedistDir") {
        let p = PathBuf::from(v);
        if p.is_dir() {
            return Some(p);
        }
    }

    // 普通终端里没有上面那个变量，用 vswhere 现查。VS 把「该配哪个 redist 版本」
    // 写在 Microsoft.VCRedistVersion.default.txt 里，照它取才和编译器对得上。
    let program_files_x86 = std::env::var("ProgramFiles(x86)")
        .or_else(|_| std::env::var("ProgramFiles"))
        .ok()?;
    let vswhere = PathBuf::from(program_files_x86)
        .join("Microsoft Visual Studio")
        .join("Installer")
        .join("vswhere.exe");
    if !vswhere.is_file() {
        return None;
    }

    let out = std::process::Command::new(&vswhere)
        .args(["-latest", "-products", "*", "-property", "installationPath"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let vs_root = PathBuf::from(
        stdout
            .lines()
            .map(str::trim)
            .find(|l| !l.is_empty())?,
    );

    let version = std::fs::read_to_string(
        vs_root
            .join("VC")
            .join("Auxiliary")
            .join("Build")
            .join("Microsoft.VCRedistVersion.default.txt"),
    )
    .ok()?;
    let root = vs_root
        .join("VC")
        .join("Redist")
        .join("MSVC")
        .join(version.trim());
    if root.is_dir() {
        Some(root)
    } else {
        None
    }
}

/// 在 `<redist>\<arch>\` 下找形如 `Microsoft.VC143.CRT` 的子目录，按名字取最新的。
/// `suffix` 传小写（".crt" / ".openmp"），比较时忽略大小写。
fn newest_redist_subdir(arch_dir: &Path, suffix: &str) -> Option<PathBuf> {
    let mut hits: Vec<PathBuf> = std::fs::read_dir(arch_dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .filter(|p| {
            p.file_name()
                .and_then(|s| s.to_str())
                .map(|n| {
                    let n = n.to_ascii_lowercase();
                    n.starts_with("microsoft.vc") && n.ends_with(suffix)
                })
                .unwrap_or(false)
        })
        .collect();
    hits.sort();
    hits.pop()
}
