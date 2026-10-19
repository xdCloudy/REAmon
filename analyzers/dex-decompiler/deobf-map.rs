use anyhow::{Context, Result};
use dex_decompiler::{
    build_deobf_rename_map, load_dexes_from_paths, save_mapping_file, DeobfuscateOptions,
    MappingFormat,
};
use std::env;
use std::path::Path;

fn run() -> Result<()> {
    let mut args = env::args_os().skip(1);
    let input = args.next().context("usage: reamon-dex-map <apk-or-dex> <mapping-output>")?;
    let output = args.next().context("usage: reamon-dex-map <apk-or-dex> <mapping-output>")?;
    if args.next().is_some() {
        anyhow::bail!("usage: reamon-dex-map <apk-or-dex> <mapping-output>");
    }

    let dexes = load_dexes_from_paths(&[Path::new(&input)])
        .context("load all DEX files to build a consistent project-wide rename map")?;
    let dex_refs: Vec<_> = dexes.iter().collect();
    let mapping = build_deobf_rename_map(&dex_refs, &DeobfuscateOptions::default());
    save_mapping_file(Path::new(&output), &mapping, MappingFormat::ProGuard)
        .context("write project-wide deobfuscation map")?;
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error:#}");
        std::process::exit(1);
    }
}
