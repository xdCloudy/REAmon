use anyhow::{Context, Result};
use dex_decompiler::{java, load_dexes_from_bytes, Decompiler};
use serde_json::{json, Value};
use std::env;
use std::fs;
use std::path::PathBuf;

const MAX_METHODS: usize = 10_000;
const MAX_ROWS_PER_METHOD: usize = 4_000;
const MAX_CFG_BLOCKS: usize = 12;
const MAX_CFG_EDGES: usize = 16;

fn run() -> Result<()> {
    let input = env::args_os()
        .nth(1)
        .context("usage: reamon-dex-structure <apk-or-dex>")?;
    let input = PathBuf::from(input);
    let bytes = fs::read(&input).context("read input")?;
    let dexes = load_dexes_from_bytes(&bytes, &input)
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    let mut methods = Vec::new();
    let mut discovered = 0usize;
    let mut truncated = false;

    'dexes: for (dex_index, dex) in dexes.iter().enumerate() {
        let decompiler = Decompiler::new(dex);
        for class_result in dex.class_defs() {
            let class = class_result.map_err(|error| anyhow::anyhow!(error.to_string()))?;
            let descriptor = dex
                .get_type(class.class_idx)
                .map_err(|error| anyhow::anyhow!(error.to_string()))?;
            let class_name = java::descriptor_to_java(&descriptor);
            let Some(data) = dex
                .get_class_data(&class)
                .map_err(|error| anyhow::anyhow!(error.to_string()))?
            else {
                continue;
            };
            for method in data
                .direct_methods
                .iter()
                .chain(data.virtual_methods.iter())
            {
                if method.code_off == 0 {
                    continue;
                }
                discovered += 1;
                if methods.len() >= MAX_METHODS {
                    truncated = true;
                    break 'dexes;
                }
                let info = dex
                    .get_method_info(method.method_idx)
                    .map_err(|error| anyhow::anyhow!(error.to_string()))?;
                let Ok((rows, nodes, edges)) = decompiler.get_method_bytecode_and_cfg(method)
                else {
                    continue;
                };
                let rows: Vec<Value> = rows.into_iter().take(MAX_ROWS_PER_METHOD).map(|row| {
                    json!({"offset": row.offset, "mnemonic": row.mnemonic, "operands": row.operands})
                }).collect();
                let mnemonics: Vec<String> = rows
                    .iter()
                    .take(128)
                    .filter_map(|row| {
                        row.get("mnemonic")
                            .and_then(Value::as_str)
                            .map(str::to_owned)
                    })
                    .collect();
                let blocks: Vec<Value> = nodes
                    .iter()
                    .take(MAX_CFG_BLOCKS)
                    .map(|node| {
                        let samples: Vec<String> = rows
                            .iter()
                            .filter(|row| {
                                row.get("offset")
                                    .and_then(Value::as_u64)
                                    .is_some_and(|offset| {
                                        offset >= node.start_offset as u64
                                            && offset < node.end_offset as u64
                                    })
                            })
                            .take(1)
                            .filter_map(|row| {
                                let mnemonic = row.get("mnemonic")?.as_str()?;
                                let operands =
                                    row.get("operands").and_then(Value::as_str).unwrap_or("");
                                Some(
                                    format!("{mnemonic} {operands}")
                                        .trim()
                                        .chars()
                                        .take(100)
                                        .collect(),
                                )
                            })
                            .collect();
                        let instruction_count = rows
                            .iter()
                            .filter(|row| {
                                row.get("offset")
                                    .and_then(Value::as_u64)
                                    .is_some_and(|offset| {
                                        offset >= node.start_offset as u64
                                            && offset < node.end_offset as u64
                                    })
                            })
                            .count();
                        json!([
                            node.id,
                            node.label,
                            instruction_count,
                            instruction_count,
                            samples,
                            []
                        ])
                    })
                    .collect();
                let cfg_edges: Vec<Value> = edges
                    .iter()
                    .take(MAX_CFG_EDGES)
                    .map(|edge| json!([edge.from_id, edge.to_id, "flow"]))
                    .collect();
                let signature = format!(
                    "{}#{}({}):{}",
                    class_name,
                    info.name,
                    info.params.join(","),
                    info.return_type
                );
                methods.push(json!({
                    "signature": signature,
                    "className": class_name,
                    "methodName": info.name,
                    "relativePath": format!("{}.java", class_name.replace('.', "/")),
                    "dexIndex": dex_index,
                    "methodIndex": method.method_idx,
                    "instructionCount": rows.len(),
                    "instructionMnemonics": mnemonics,
                    "controlFlowGraph": {
                        "entryBlock": nodes.first().map(|node| node.id).unwrap_or(0),
                        "exitBlock": nodes.last().map(|node| node.id).unwrap_or(0),
                        "blockCount": nodes.len(),
                        "edgeCount": edges.len(),
                        "blocks": blocks,
                        "edges": cfg_edges,
                    },
                    "bytecodeRowsTruncated": rows.len() >= MAX_ROWS_PER_METHOD,
                    "cfgTruncated": nodes.len() > MAX_CFG_BLOCKS || edges.len() > MAX_CFG_EDGES,
                }));
            }
        }
    }
    println!(
        "{}",
        json!({"methods": methods, "discoveredMethodCount": discovered, "truncated": truncated})
    );
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error:#}");
        std::process::exit(2);
    }
}
