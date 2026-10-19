use anyhow::{Context, Result};
use dex_decompiler::{
    class_name_to_path, getclass_java, load_mapping_file, parse_dex, DecompilationMode,
    DecompilerOptions,
};
use serde_json::json;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

fn run() -> Result<()> {
    let mut args = env::args_os().skip(1);
    let usage = "usage: reamon-dex-batch <dex> <mapping> <output-dir> <start-index> <class-limit>";
    let input = args.next().context(usage)?;
    let mapping_path = args.next().context(usage)?;
    let output_root = args.next().context(usage)?;
    let start_index: usize = args.next().context(usage)?.to_string_lossy().parse().context("invalid start index")?;
    let class_limit: usize = args.next().context(usage)?.to_string_lossy().parse().context("invalid class limit")?;
    if class_limit == 0 || class_limit > 1_000 {
        anyhow::bail!("class limit must be between 1 and 1000");
    }
    if args.next().is_some() {
        anyhow::bail!(usage);
    }

    let input = PathBuf::from(input);
    let output_root = PathBuf::from(output_root);
    let bytes = fs::read(&input).with_context(|| format!("read {}", input.display()))?;
    let dex = parse_dex(&bytes).context("parse DEX")?;
    let mapping = load_mapping_file(Path::new(&mapping_path)).context("load shared deobfuscation map")?;
    let options = DecompilerOptions {
        rename_map: Some(mapping),
        mode: DecompilationMode::Restructure,
        ..DecompilerOptions::default()
    };

    let mut discovered = 0usize;
    let mut returned = 0usize;
    let mut failed = 0usize;
    for (class_index, class_result) in dex.class_defs().enumerate() {
        discovered += 1;
        if class_index < start_index || class_index >= start_index.saturating_add(class_limit) {
            continue;
        }
        let class = class_result.context("read DEX class definition")?;
        let descriptor = dex
            .get_type(class.class_idx)
            .context("read class descriptor")?;
        let class_name = dex_decompiler::java::descriptor_to_java(&descriptor);
        let source = match getclass_java(&bytes, &class_name, options.clone()) {
            Ok(source) => source,
            Err(_) => {
                failed += 1;
                continue;
            }
        };
        let (relative_dir, file_name) = class_name_to_path(&class_name);
        let target = output_root.join(relative_dir).join(file_name);
        if !target.starts_with(&output_root) {
            anyhow::bail!("generated Java path escaped the output directory");
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).context("create Java package directory")?;
        }
        fs::write(&target, source).with_context(|| format!("write {}", target.display()))?;
        returned += 1;
    }

    println!("{}", json!({
        "discoveredClassCount": discovered,
        "returnedClassCount": returned,
        "failedClassCount": failed,
        "startIndex": start_index,
        "classLimit": class_limit,
    }));
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error:#}");
        std::process::exit(1);
    }
}
