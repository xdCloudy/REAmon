#!/usr/local/bin/ruby
require "digest"
require "json"
require "rbconfig"

MAX_STRUCTURED_BYTES = 192 * 1024
MAX_SEQUENCES = 96
MAX_INSTRUCTIONS = 1200
MAX_DEPTH = 20
MAX_OPERANDS = 12
MAX_VALUE_ITEMS = 32
MAX_STRING_BYTES = 160

def emit(value, status = 0)
  STDOUT.write(JSON.generate(value))
  exit(status)
end

def bounded_string(value)
  string = value.to_s.encode("UTF-8", invalid: :replace, undef: :replace, replace: "�")
  string.byteslice(0, MAX_STRING_BYTES).to_s
end

def structured_iseq(root)
  state = { sequences: [], instructionCount: 0, truncated: false, seen: {} }

  normalize = nil
  extract = nil
  normalize = lambda do |value, depth|
    if defined?(RubyVM::InstructionSequence) && value.is_a?(RubyVM::InstructionSequence)
      { "sequenceRef" => extract.call(value, depth + 1) }
    elsif value.nil? || value == true || value == false || value.is_a?(Integer) || value.is_a?(Float)
      value
    elsif value.is_a?(Symbol)
      bounded_string(value)
    elsif value.is_a?(String)
      bounded_string(value)
    elsif depth >= MAX_DEPTH
      state[:truncated] = true
      "<depth-limit>"
    elsif value.is_a?(Array)
      state[:truncated] = true if value.length > MAX_VALUE_ITEMS
      value.first(MAX_VALUE_ITEMS).map { |item| normalize.call(item, depth + 1) }
    elsif value.is_a?(Hash)
      state[:truncated] = true if value.length > MAX_VALUE_ITEMS
      value.first(MAX_VALUE_ITEMS).each_with_object({}) do |(key, item), result|
        result[bounded_string(key)] = normalize.call(item, depth + 1)
      end
    else
      { "valueType" => bounded_string(value.class.name) }
    end
  end

  extract = lambda do |iseq, depth|
    object_id = iseq.object_id
    next state[:seen][object_id] if state[:seen].key?(object_id)
    if depth > MAX_DEPTH || state[:sequences].length >= MAX_SEQUENCES
      state[:truncated] = true
      next nil
    end

    index = state[:sequences].length
    state[:seen][object_id] = index
    sequence = {
      id: index,
      label: bounded_string(iseq.label),
      type: bounded_string(iseq.to_a[9]),
      firstLine: iseq.to_a[8].is_a?(Integer) ? iseq.to_a[8] : nil,
      locals: [],
      parameters: nil,
      catchTable: [],
      instructions: [],
      truncated: false,
    }
    state[:sequences] << sequence

    data = iseq.to_a
    locals = data[10].is_a?(Array) ? data[10] : []
    sequence[:locals] = locals.first(256).map { |name| bounded_string(name) }
    sequence[:truncated] = true if locals.length > 256
    sequence[:parameters] = normalize.call(data[11], 0)
    catches = data[12].is_a?(Array) ? data[12] : []
    sequence[:catchTable] = catches.first(128).map { |entry| normalize.call(entry, 0) }
    sequence[:truncated] = true if catches.length > 128
    body = data[13].is_a?(Array) ? data[13] : []
    body.each do |entry|
      unless entry.is_a?(Array)
        state[:truncated] = true
        sequence[:truncated] = true
        next
      end
      if state[:instructionCount] >= MAX_INSTRUCTIONS
        state[:truncated] = true
        sequence[:truncated] = true
        break
      end
      state[:instructionCount] += 1
      head = entry.first
      operands = entry.drop(1).first(MAX_OPERANDS).map { |operand| normalize.call(operand, 0) }
      sequence[:truncated] = true if entry.length - 1 > MAX_OPERANDS
      if head.to_s.start_with?("RUBY_EVENT_")
        sequence[:instructions] << { event: bounded_string(head), operands: operands }
      else
        sequence[:instructions] << { opcode: bounded_string(head), operands: operands }
      end
    end
    sequence[:truncated] = true if state[:truncated]
    index
  end

  root_id = extract.call(root, 0)
  result = {
    format: "YARVInstructionSequence/SimpleDataFormat",
    runtimeVersion: RUBY_DESCRIPTION,
    rootSequenceId: root_id,
    sequenceCount: state[:sequences].length,
    instructionCount: state[:instructionCount],
    truncated: state[:truncated],
    sequences: state[:sequences],
  }
  encoded = JSON.generate(result)
  raise ArgumentError, "Structured CRuby ISeq evidence exceeds the configured output limit" if encoded.bytesize > MAX_STRUCTURED_BYTES
  { evidence: result, sha256: Digest::SHA256.hexdigest(encoded), bytes: encoded.bytesize }
end

begin
  Process.setrlimit(Process::RLIMIT_CPU, 25, 25)
  Process.setrlimit(Process::RLIMIT_AS, 384 * 1024 * 1024, 384 * 1024 * 1024) if Process.const_defined?(:RLIMIT_AS)
  source_path = ARGV.fetch(0)
  max_input = Integer(ENV.fetch("CRUBY_ISEQ_MAX_INPUT_BYTES", "16777216"))
  max_output = Integer(ENV.fetch("CRUBY_ISEQ_MAX_OUTPUT_BYTES", "524288"))
  size = File.size(source_path)
  emit({ error: "CRuby ISeq input size is outside the configured limit" }, 2) unless size.between?(8, max_input)

  bytes = File.binread(source_path, max_input + 1)
  emit({ error: "Input does not have the CRuby YARB ISeq signature" }, 2) unless bytes.start_with?("YARB")
  unless defined?(RubyVM::InstructionSequence) && RubyVM::InstructionSequence.respond_to?(:load_from_binary)
    emit({ error: "This Ruby runtime cannot load CRuby ISeq binaries" }, 2)
  end

  iseq = RubyVM::InstructionSequence.load_from_binary(bytes)
  disassembly = iseq.disasm
  structured = structured_iseq(iseq)
  output_bytes = disassembly.bytesize
  emit({ error: "CRuby ISeq disassembly exceeds the configured output limit" }, 2) if output_bytes.zero? || output_bytes > max_output
  instruction_count = disassembly.lines.count { |line| line.match?(/^\s*\d{4,}\s/) }
  emit({
    status: "completed",
    runtimeVersion: RUBY_DESCRIPTION,
    runtimeEngine: RUBY_ENGINE,
    binarySignature: "YARB",
    inputSha256: Digest::SHA256.hexdigest(bytes),
    inputBytes: bytes.bytesize,
    outputSha256: Digest::SHA256.hexdigest(disassembly),
    outputBytes: output_bytes,
    instructionCount: instruction_count,
    structuredEvidenceJson: JSON.generate(structured.fetch(:evidence)),
    structuredEvidenceSha256: structured.fetch(:sha256),
    structuredEvidenceBytes: structured.fetch(:bytes),
    disassembly: disassembly,
    warnings: "CRuby YARV instruction evidence only; target instructions were not evaluated and this output is not recovered Ruby source."
  })
rescue StandardError => error
  emit({ error: "CRuby rejected this ISeq artifact: #{error.class}: #{error.message.to_s[0, 300]}" }, 2)
end
