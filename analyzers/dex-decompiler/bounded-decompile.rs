use anyhow::{Context, Result};
use dex_decompiler::{
    class_name_to_path, load_mapping_file, parse_dex, DecompilationMode, Decompiler,
    DecompilerOptions,
};
use dex_parser::DexSlicer;
use serde_json::json;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

fn parse_mode(value: &str) -> Result<DecompilationMode> {
    match value {
        "restructure" => Ok(DecompilationMode::Restructure),
        "simple" => Ok(DecompilationMode::Simple),
        "fallback" => Ok(DecompilationMode::Fallback),
        _ => anyhow::bail!("mode must be restructure, simple, or fallback"),
    }
}

fn record_failed_class(failed: &mut usize, failed_indices: &mut Vec<usize>, class_index: usize) {
    *failed += 1;
    failed_indices.push(class_index);
}

fn run() -> Result<()> {
    let mut args = env::args_os().skip(1);
    let usage = "usage: reamon-dex-batch <dex> <mapping> <output-dir> <start-index> <class-limit> [restructure|simple|fallback]";
    let input = args.next().context(usage)?;
    let mapping_path = args.next().context(usage)?;
    let output_root = args.next().context(usage)?;
    let start_index: usize = args
        .next()
        .context(usage)?
        .to_string_lossy()
        .parse()
        .context("invalid start index")?;
    let class_limit: usize = args
        .next()
        .context(usage)?
        .to_string_lossy()
        .parse()
        .context("invalid class limit")?;
    let mode = args
        .next()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| "restructure".to_string());
    if class_limit == 0 || class_limit > 1_000 {
        anyhow::bail!("class limit must be between 1 and 1000");
    }
    if args.next().is_some() {
        anyhow::bail!(usage);
    }

    let input = PathBuf::from(input);
    let output_root = PathBuf::from(output_root);
    let bytes = fs::read(&input).with_context(|| format!("read {}", input.display()))?;
    // Reuse the full-DEX slicer across classes; upstream getclass_java reparses it per class.
    let dex = parse_dex(&bytes).context("parse DEX")?;
    let slicer = DexSlicer::new(&bytes).context("parse DEX class slicer")?;
    let mapping = if mapping_path == "-" {
        None
    } else {
        Some(load_mapping_file(Path::new(&mapping_path)).context("load shared deobfuscation map")?)
    };
    let mode = parse_mode(&mode)?;
    let options = DecompilerOptions {
        rename_map: mapping,
        mode,
        ..DecompilerOptions::default()
    };

    let mut discovered = 0usize;
    let mut returned = 0usize;
    let mut failed = 0usize;
    let mut failed_indices = Vec::new();
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
        let sliced = match slicer.slice_class(&descriptor) {
            Ok(sliced) => sliced,
            Err(_) => {
                record_failed_class(&mut failed, &mut failed_indices, class_index);
                continue;
            }
        };
        let sliced_dex = match parse_dex(&sliced) {
            Ok(sliced_dex) => sliced_dex,
            Err(_) => {
                record_failed_class(&mut failed, &mut failed_indices, class_index);
                continue;
            }
        };
        let Some(Ok(sliced_class)) = sliced_dex.class_defs().next() else {
            record_failed_class(&mut failed, &mut failed_indices, class_index);
            continue;
        };
        let decompiler = Decompiler::with_options(&sliced_dex, options.clone());
        let source = match decompiler.decompile_class(&sliced_class) {
            Ok(source) => source,
            Err(_) => {
                record_failed_class(&mut failed, &mut failed_indices, class_index);
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

    println!(
        "{}",
        json!({
            "discoveredClassCount": discovered,
            "returnedClassCount": returned,
            "failedClassCount": failed,
            "failedClassIndices": failed_indices,
            "startIndex": start_index,
            "classLimit": class_limit,
        })
    );
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error:#}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_mode, record_failed_class};
    use dex_decompiler::DecompilationMode;

    #[test]
    fn accepts_supported_decompilation_modes() {
        assert_eq!(
            parse_mode("restructure").unwrap(),
            DecompilationMode::Restructure
        );
        assert_eq!(parse_mode("simple").unwrap(), DecompilationMode::Simple);
        assert_eq!(parse_mode("fallback").unwrap(), DecompilationMode::Fallback);
    }

    #[test]
    fn rejects_unknown_decompilation_modes() {
        assert!(parse_mode("other").is_err());
    }

    #[test]
    fn failed_summary_tracks_exact_class_indexes() {
        let mut failed = 0;
        let mut indices = Vec::new();
        record_failed_class(&mut failed, &mut indices, 3);
        record_failed_class(&mut failed, &mut indices, 9);

        assert_eq!(failed, 2);
        assert_eq!(indices, vec![3, 9]);
    }
}
