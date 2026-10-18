#!/usr/local/bin/ruby
require "digest"
require "json"
require "rbconfig"

def emit(value, status = 0)
  STDOUT.write(JSON.generate(value))
  exit(status)
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
    disassembly: disassembly,
    warnings: "CRuby YARV instruction evidence only; target instructions were not evaluated and this output is not recovered Ruby source."
  })
rescue StandardError => error
  emit({ error: "CRuby rejected this ISeq artifact: #{error.class}: #{error.message.to_s[0, 300]}" }, 2)
end
