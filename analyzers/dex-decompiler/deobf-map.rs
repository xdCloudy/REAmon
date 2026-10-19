use anyhow::{Context, Result};
use dex_decompiler::{
    build_deobf_rename_map, load_dexes_from_paths, load_mapping_file, merge_rename_maps,
    save_mapping_file, DeobfuscateOptions, MappingFormat, RenameMap,
};
use std::collections::HashMap;
use std::env;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

fn max_generated_suffix<'a>(
    values: impl Iterator<Item = &'a String>,
    prefix: &str,
    class_names: bool,
) -> u32 {
    values
        .filter_map(|value| {
            let name = if class_names {
                value.rsplit('.').next().unwrap_or(value)
            } else {
                value.as_str()
            };
            name.strip_prefix(prefix)?.parse::<u32>().ok()
        })
        .max()
        .unwrap_or(0)
}

fn offset_generated_names(
    values: &mut HashMap<String, String>,
    prefix: &str,
    offset: u32,
    class_names: bool,
) {
    if offset == 0 {
        return;
    }
    for value in values.values_mut() {
        let generated = if class_names {
            value.rsplit('.').next().unwrap_or(value).to_string()
        } else {
            value.clone()
        };
        let Some(index) = generated
            .strip_prefix(prefix)
            .and_then(|suffix| suffix.parse::<u32>().ok())
        else {
            continue;
        };
        let replacement = format!("{prefix}{:04}", index.saturating_add(offset));
        if class_names {
            if let Some((package, _)) = value.rsplit_once('.') {
                *value = format!("{package}.{replacement}");
            } else {
                *value = replacement;
            }
        } else {
            *value = replacement;
        }
    }
}

fn offset_generated_map(extra: &mut RenameMap, base: &RenameMap) {
    let class_offset = max_generated_suffix(base.class.values(), "C", true);
    let method_offset = max_generated_suffix(base.method.values(), "m", false);
    let field_offset = max_generated_suffix(base.field.values(), "f", false);
    offset_generated_names(&mut extra.class, "C", class_offset, true);
    offset_generated_names(&mut extra.method, "m", method_offset, false);
    offset_generated_names(&mut extra.field, "f", field_offset, false);
}

fn run() -> Result<()> {
    let mut args = env::args_os().skip(1);
    let input = args
        .next()
        .context("usage: reamon-dex-map <dex> <mapping-output>")?;
    let output = PathBuf::from(
        args.next()
            .context("usage: reamon-dex-map <dex> <mapping-output>")?,
    );
    if args.next().is_some() {
        anyhow::bail!("usage: reamon-dex-map <dex> <mapping-output>");
    }

    let dexes = load_dexes_from_paths(&[Path::new(&input)])
        .context("load one DEX file for bounded project-wide map construction")?;
    let dex_refs: Vec<_> = dexes.iter().collect();
    let discovered_class_count: usize = dex_refs.iter().map(|dex| dex.class_defs().count()).sum();
    // Emit the inventory before expensive mapping so the caller can still
    // account for skipped classes if name generation fails afterward.
    println!("{}", serde_json::json!({ "discoveredClassCount": discovered_class_count }));
    io::stdout().flush().context("flush DEX class inventory")?;
    let mut mapping = if output.is_file() {
        load_mapping_file(&output).context("load accumulated project rename map")?
    } else {
        RenameMap::new()
    };
    let mut extra = build_deobf_rename_map(&dex_refs, &DeobfuscateOptions::default());
    offset_generated_map(&mut extra, &mapping);
    mapping = merge_rename_maps(mapping, extra);
    save_mapping_file(&output, &mapping, MappingFormat::ProGuard)
        .context("write accumulated project deobfuscation map")?;
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
    use super::*;

    #[test]
    fn generated_names_continue_after_existing_mapping() {
        let mut base = RenameMap::new();
        base.class.insert("a.A".into(), "com.example.C0012".into());
        base.method.insert("a.A#b".into(), "m0042".into());
        base.field.insert("a.A#c".into(), "f0007".into());

        let mut extra = RenameMap::new();
        extra.class.insert("b.B".into(), "com.example.C0001".into());
        extra.method.insert("b.B#d".into(), "m0001".into());
        extra.field.insert("b.B#e".into(), "f0001".into());

        offset_generated_map(&mut extra, &base);

        assert_eq!(
            extra.class.get("b.B").map(String::as_str),
            Some("com.example.C0013")
        );
        assert_eq!(extra.method.get("b.B#d").map(String::as_str), Some("m0043"));
        assert_eq!(extra.field.get("b.B#e").map(String::as_str), Some("f0008"));
    }
}
