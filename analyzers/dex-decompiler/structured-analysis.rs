use anyhow::{Context, Result};
use dex_decompiler::{java, load_dexes_from_bytes, Decompiler};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::env;
use std::fs;
use std::path::PathBuf;

const METHOD_PAGE_SIZE: usize = 1_000;
const EDGE_PAGE_SIZE: usize = 1_000;
const MAX_EDGE_PAGES: usize = 4_200;
const MAX_EDGE_EVIDENCE_BYTES: usize = 256 * 1024 * 1024;
const MAX_ROWS_PER_METHOD: usize = 4_000;
const MAX_CFG_BLOCKS: usize = 12;
const MAX_CFG_EDGES: usize = 16;
const MAX_METHOD_ARTIFACT_BYTES: usize = 1024 * 1024;
const MAX_TOTAL_ARTIFACT_BYTES: usize = 128 * 1024 * 1024;

fn resolved_invoke_method_index(
    dex: &dex_decompiler::DexFile,
    insns: &[u8],
    offset: u32,
    opcode: u8,
) -> Option<u32> {
    let offset = offset as usize;
    if matches!(opcode, 0x6e..=0x72 | 0x74..=0x78 | 0xfa | 0xfb) {
        if offset + 4 > insns.len() {
            return None;
        }
        return Some(u16::from_le_bytes([insns[offset + 2], insns[offset + 3]]) as u32);
    }
    if !matches!(opcode, 0xfc | 0xfd) || offset + 4 > insns.len() {
        return None;
    }
    let call_site_index = u16::from_le_bytes([insns[offset + 2], insns[offset + 3]]) as u32;
    let call_site = dex.get_call_site(call_site_index).ok()?;
    dex_parser::DexCallSites::impl_method_id(&call_site).map(u32::from)
}

fn flush_method_page(root: &PathBuf, page: usize, methods: &mut Vec<Value>, pages: &mut Vec<String>) -> Result<()> {
    if methods.is_empty() {
        return Ok(());
    }
    let name = format!("method-page-{page:06}.json");
    let path = root.join(&name);
    fs::write(&path, serde_json::to_vec(&json!({"methods": methods}))?)
        .with_context(|| format!("write method page {page}"))?;
    pages.push(name);
    methods.clear();
    Ok(())
}

fn flush_edge_page(
    root: &PathBuf,
    prefix: &str,
    page: usize,
    rows: &mut Vec<Value>,
    pages: &mut Vec<String>,
    total_bytes: &mut usize,
) -> Result<bool> {
    if rows.is_empty() {
        return Ok(true);
    }
    let name = format!("{prefix}-page-{page:06}.json");
    let path = root.join(&name);
    let encoded = serde_json::to_vec(&json!({"rows": rows}))?;
    if total_bytes.saturating_add(encoded.len()) > MAX_EDGE_EVIDENCE_BYTES {
        rows.clear();
        return Ok(false);
    }
    let encoded_len = encoded.len();
    fs::write(&path, encoded)
        .with_context(|| format!("write {prefix} page {page}"))?;
    *total_bytes += encoded_len;
    pages.push(name);
    rows.clear();
    Ok(true)
}

fn run() -> Result<()> {
    let input = env::args_os()
        .nth(1)
        .context("usage: reamon-dex-structure <apk-or-dex>")?;
    let evidence_root = env::args_os()
        .nth(2)
        .context("usage: reamon-dex-structure <apk-or-dex> <evidence-output-dir>")?;
    let input = PathBuf::from(input);
    let evidence_root = PathBuf::from(evidence_root);
    fs::create_dir_all(&evidence_root).context("create evidence output directory")?;
    let method_pages_root = evidence_root.join("method-pages");
    fs::create_dir_all(&method_pages_root).context("create method page directory")?;
    let call_pages_root = evidence_root.join("call-pages");
    fs::create_dir_all(&call_pages_root).context("create call page directory")?;
    let reference_pages_root = evidence_root.join("reference-pages");
    fs::create_dir_all(&reference_pages_root).context("create reference page directory")?;
    let bytes = fs::read(&input).context("read input")?;
    let dexes = load_dexes_from_bytes(&bytes, &input)
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    let mut defined_methods = HashMap::new();
    let mut discovered = 0usize;
    for (dex_index, dex) in dexes.iter().enumerate() {
        for class_result in dex.class_defs() {
            let class = class_result.map_err(|error| anyhow::anyhow!(error.to_string()))?;
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
                let info = dex
                    .get_method_info(method.method_idx)
                    .map_err(|error| anyhow::anyhow!(error.to_string()))?;
                let class_name = java::descriptor_to_java(&info.class);
                let signature = format!(
                    "{}#{}({}):{}",
                    class_name,
                    info.name,
                    info.params.join(","),
                    info.return_type
                );
                defined_methods
                    .entry(signature)
                    .or_insert((dex_index, method.method_idx));
            }
        }
    }
    let mut methods = Vec::new();
    let mut method_pages = Vec::new();
    let mut returned_methods = 0usize;
    let mut total_evidence_bytes = 0usize;
    let mut calls = Vec::new();
    let mut call_pages = Vec::new();
    let mut returned_calls = 0usize;
    let mut call_graph_truncated = false;
    let mut references = Vec::new();
    let mut reference_pages = Vec::new();
    let mut returned_references = 0usize;
    let mut references_truncated = false;
    let mut total_edge_page_bytes = 0usize;

    for (dex_index, dex) in dexes.iter().enumerate() {
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
                let rows_truncated = rows.len() >= MAX_ROWS_PER_METHOD;
                let signature = format!(
                    "{}#{}({}):{}",
                    class_name,
                    info.name,
                    info.params.join(","),
                    info.return_type
                );
                let evidence = serde_json::to_vec(&json!({
                    "signature": signature,
                    "dexIndex": dex_index,
                    "methodIndex": method.method_idx,
                    "instructions": &rows,
                    "truncated": rows_truncated,
                }))?;
                let evidence_path = evidence_root
                    .join(format!("dex-{dex_index}"))
                    .join(format!("method-{}.json", method.method_idx));
                let evidence_relative_path = if evidence.len() <= MAX_METHOD_ARTIFACT_BYTES
                    && total_evidence_bytes.saturating_add(evidence.len()) <= MAX_TOTAL_ARTIFACT_BYTES
                {
                    if let Some(parent) = evidence_path.parent() {
                        fs::create_dir_all(parent).context("create method evidence directory")?;
                    }
                    fs::write(&evidence_path, &evidence).context("write method evidence")?;
                    total_evidence_bytes += evidence.len();
                    Some(format!("dex-{dex_index}/method-{}.json", method.method_idx))
                } else {
                    None
                };
                let mut targets: HashMap<u32, (String, String, String, usize, Vec<u32>)> = HashMap::new();
                let mut reference_targets: HashMap<(u8, u32), (String, String, usize, Vec<u32>, bool)> = HashMap::new();
                if let Ok(code) = dex.get_code_item(method.code_off) {
                    let insns = code.insns_slice(&dex.data);
                    if let Ok(instructions) = dex_bytecode::decode_all(insns, 0) {
                        for instruction in instructions {
                            if let Some(callee_idx) = resolved_invoke_method_index(
                                dex, insns, instruction.offset, instruction.opcode,
                            ) {
                                if let Ok(target_info) = dex.get_method_info(callee_idx) {
                                    let target_class = java::descriptor_to_java(&target_info.class);
                                    let target_signature = format!(
                                        "{}#{}({}):{}",
                                        target_class,
                                        target_info.name,
                                        target_info.params.join(","),
                                        target_info.return_type
                                    );
                                    let target = targets.entry(callee_idx).or_insert_with(|| (
                                        target_class.clone(),
                                        target_info.name,
                                        target_signature,
                                        0,
                                        Vec::new(),
                                    ));
                                    target.3 += 1;
                                    if target.4.len() < 3 {
                                        target.4.push(instruction.offset);
                                    }
                                }
                            }

                            let offset = instruction.offset as usize;
                            let opcode = instruction.opcode;
                            if matches!(opcode, 0x52..=0x6d) && offset + 4 <= insns.len() {
                                let reference_idx = u16::from_le_bytes([insns[offset + 2], insns[offset + 3]]) as u32;
                                if let Ok(field) = dex.get_field_info(reference_idx) {
                                    let owner = java::descriptor_to_java(&field.class);
                                    let target_signature = format!("{}#{}", owner, field.name);
                                    let access_kind = if matches!(opcode, 0x59..=0x5f | 0x67..=0x6d) { 2 } else { 1 };
                                    let target = reference_targets.entry((access_kind, reference_idx)).or_insert_with(|| (
                                        target_signature.clone(),
                                        target_signature,
                                        0,
                                        Vec::new(),
                                        false,
                                    ));
                                    target.2 += 1;
                                    if target.3.len() < 3 { target.3.push(instruction.offset); }
                                }
                            } else if matches!(opcode, 0x1a | 0x1b) {
                                let string_idx = if opcode == 0x1a {
                                    if offset + 4 > insns.len() { continue; }
                                    u16::from_le_bytes([insns[offset + 2], insns[offset + 3]]) as u32
                                } else {
                                    if offset + 6 > insns.len() { continue; }
                                    u32::from_le_bytes([insns[offset + 2], insns[offset + 3], insns[offset + 4], insns[offset + 5]])
                                };
                                if let Ok(value) = dex.get_string(string_idx) {
                                    let preview: String = value.chars().take(256).collect();
                                    let target_signature = format!("string@{string_idx}");
                                    let target = reference_targets.entry((3, string_idx)).or_insert_with(|| (
                                        target_signature,
                                        preview,
                                        0,
                                        Vec::new(),
                                        value.chars().count() > 256,
                                    ));
                                    target.2 += 1;
                                    if target.3.len() < 3 { target.3.push(instruction.offset); }
                                }
                            }
                        }
                    }
                }
                let mut ordered_targets: Vec<_> = targets.into_iter().collect();
                ordered_targets.sort_by_key(|(method_idx, _)| *method_idx);
                for (target_idx, (target_class, target_name, target_signature, call_site_count, offsets)) in ordered_targets {
                    if call_graph_truncated {
                        break;
                    }
                    if returned_calls >= MAX_EDGE_PAGES * EDGE_PAGE_SIZE {
                        call_graph_truncated = true;
                        break;
                    }
                    let target_path = format!("{}.java", target_class.replace('.', "/"));
                    let (target_dex_index, target_method_index) = defined_methods
                        .get(&target_signature)
                        .copied()
                        .unwrap_or((dex_index, target_idx));
                    calls.push(json!({
                        "fromSignature": signature,
                        "toSignature": target_signature,
                        "fromRelativePath": format!("{}.java", class_name.replace('.', "/")),
                        "toRelativePath": target_path,
                        "fromAddress": format!("dex{dex_index}:method#{}", method.method_idx),
                        "toAddress": format!("dex{target_dex_index}:method#{target_method_index}"),
                        "fromDexIndex": dex_index,
                        "toDexIndex": target_dex_index,
                        "fromMethodIndex": method.method_idx,
                        "toMethodIndex": target_method_index,
                        "callSiteCount": call_site_count,
                        "offsets": offsets,
                        "targetName": target_name,
                    }));
                    returned_calls += 1;
                    if calls.len() >= EDGE_PAGE_SIZE {
                        let pending = calls.len();
                        if !flush_edge_page(&call_pages_root, "call", call_pages.len(), &mut calls, &mut call_pages, &mut total_edge_page_bytes)? {
                            returned_calls -= pending;
                            call_graph_truncated = true;
                        }
                    }
                }
                let mut ordered_references: Vec<_> = reference_targets.into_iter().collect();
                ordered_references.sort_by_key(|((kind, index), _)| (*kind, *index));
                for ((kind, target_index), (target_signature, target_name, occurrence_count, offsets, target_name_truncated)) in ordered_references {
                    if references_truncated {
                        break;
                    }
                    if returned_references >= MAX_EDGE_PAGES * EDGE_PAGE_SIZE {
                        references_truncated = true;
                        break;
                    }
                    references.push(json!({
                        "kind": match kind { 1 => "field_read", 2 => "field_write", _ => "string_literal" },
                        "fromSignature": signature,
                        "fromRelativePath": format!("{}.java", class_name.replace('.', "/")),
                        "fromDexIndex": dex_index,
                        "fromMethodIndex": method.method_idx,
                        "fromAddress": format!("dex{dex_index}:method#{}", method.method_idx),
                        "targetSignature": target_signature,
                        "targetName": target_name,
                        "targetNameTruncated": target_name_truncated,
                        "targetDexIndex": dex_index,
                        "targetIndex": target_index,
                        "occurrenceCount": occurrence_count,
                        "offsets": offsets,
                    }));
                    returned_references += 1;
                    if references.len() >= EDGE_PAGE_SIZE {
                        let pending = references.len();
                        if !flush_edge_page(&reference_pages_root, "reference", reference_pages.len(), &mut references, &mut reference_pages, &mut total_edge_page_bytes)? {
                            returned_references -= pending;
                            references_truncated = true;
                        }
                    }
                }
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
                    "bytecodeRowsTruncated": rows_truncated || evidence_relative_path.is_none(),
                    "bytecodeArtifactPath": evidence_relative_path,
                    "cfgTruncated": nodes.len() > MAX_CFG_BLOCKS || edges.len() > MAX_CFG_EDGES,
                }));
                returned_methods += 1;
                if methods.len() >= METHOD_PAGE_SIZE {
                    flush_method_page(&method_pages_root, method_pages.len(), &mut methods, &mut method_pages)?;
                }
            }
        }
    }
    flush_method_page(&method_pages_root, method_pages.len(), &mut methods, &mut method_pages)?;
    let pending_calls = calls.len();
    if !flush_edge_page(&call_pages_root, "call", call_pages.len(), &mut calls, &mut call_pages, &mut total_edge_page_bytes)? {
        returned_calls -= pending_calls;
        call_graph_truncated = true;
    }
    let pending_references = references.len();
    if !flush_edge_page(&reference_pages_root, "reference", reference_pages.len(), &mut references, &mut reference_pages, &mut total_edge_page_bytes)? {
        returned_references -= pending_references;
        references_truncated = true;
    }
    println!(
        "{}",
        json!({
            "methods": [],
            "methodPageCount": method_pages.len(),
            "methodPages": method_pages,
            "returnedMethodCount": returned_methods,
            "discoveredMethodCount": discovered,
            "truncated": returned_methods < discovered,
            "evidenceBytes": total_evidence_bytes,
            "calls": [],
            "returnedCallCount": returned_calls,
            "callPages": call_pages,
            "callPageCount": call_pages.len(),
            "callGraphTruncated": call_graph_truncated,
            "references": [],
            "returnedReferenceCount": returned_references,
            "referencePages": reference_pages,
            "referencePageCount": reference_pages.len(),
            "referencesTruncated": references_truncated,
        })
    );
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error:#}");
        std::process::exit(2);
    }
}
