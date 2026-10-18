#!/usr/local/bin/ruby
require "json"
require "open3"
require "socket"
require "timeout"
require "fileutils"
require "securerandom"
require "digest"

PORT = Integer(ENV.fetch("PORT", "8030"))
ARTIFACT_ROOT = File.realpath(ENV.fetch("REAMON_ARTIFACTS_PATH", "/data/reamon-artifacts"))
DERIVED_ROOT = File.expand_path(ENV.fetch("REAMON_DERIVED_PATH", "/data/reamon-derived"))
MAX_INPUT = Integer(ENV.fetch("CRUBY_ISEQ_MAX_INPUT_BYTES", "16777216"))
MAX_OUTPUT = Integer(ENV.fetch("CRUBY_ISEQ_MAX_OUTPUT_BYTES", "524288"))
TIMEOUT_SECONDS = Integer(ENV.fetch("CRUBY_ISEQ_TIMEOUT_SECONDS", "35"))
MAX_REQUEST = 16 * 1024
SAFE_ID = /\A[A-Za-z0-9][A-Za-z0-9_-]{0,127}\z/
WORKER = File.expand_path("worker.rb", __dir__)
DECOMPILE_WORKER = File.expand_path("decompile_worker.py", __dir__)
DECOMPILE_TIMEOUT_SECONDS = 22
MAX_RECONSTRUCTED_SOURCE = 512 * 1024

def json_response(socket, code, body)
  payload = JSON.generate(body)
  reason = code == 200 ? "OK" : code == 429 ? "Too Many Requests" : "Unprocessable Entity"
  socket.write("HTTP/1.1 #{code} #{reason}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: #{payload.bytesize}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n#{payload}")
end

def read_request(socket)
  request_line = socket.gets(4096)
  raise ArgumentError, "Invalid HTTP request" unless request_line && request_line.bytesize < 4096
  method, path, = request_line.split(" ", 3)
  headers = {}
  header_bytes = request_line.bytesize
  while (line = socket.gets(4096))
    header_bytes += line.bytesize
    raise ArgumentError, "Request headers are too large" if header_bytes > MAX_REQUEST
    break if line == "\r\n" || line == "\n"
    key, value = line.split(":", 2)
    headers[key.to_s.downcase] = value.to_s.strip
  end
  length = Integer(headers.fetch("content-length", "0"))
  raise ArgumentError, "Request body size is invalid" unless length.between?(1, MAX_REQUEST)
  body = socket.read(length)
  raise ArgumentError, "Request body is incomplete" unless body&.bytesize == length
  [method, path, JSON.parse(body)]
end

def safe_id(value)
  raise ArgumentError, "Invalid analysis identifier" unless value.is_a?(String) && SAFE_ID.match?(value)
  value
end

def resolve_input(value)
  raise ArgumentError, "Invalid artifact path" unless value.is_a?(String) && value.length.between?(1, 4096)
  resolved = File.realpath(value)
  raise ArgumentError, "Artifact path is outside the read-only artifact volume" unless resolved.start_with?(ARTIFACT_ROOT + File::SEPARATOR)
  stat = File.stat(resolved)
  raise ArgumentError, "Input must be a regular file within the configured size limit" unless stat.file? && stat.size.between?(8, MAX_INPUT)
  resolved
rescue Errno::ENOENT, Errno::EACCES
  raise ArgumentError, "Artifact is not available in the read-only volume"
end

def run_inspector(input_path)
  output = +""
  error_output = +""
  Open3.popen3(RbConfig.ruby, WORKER, input_path, pgroup: true) do |stdin, stdout, stderr, wait_thread|
    stdin.close
    stderr_thread = Thread.new { stderr.read(16_384) }
    begin
      Timeout.timeout(TIMEOUT_SECONDS) do
        output = stdout.read((MAX_OUTPUT * 8) + 16_384)
        raise ArgumentError, "Inspection result exceeded the response limit" if output.bytesize > (MAX_OUTPUT * 8) + 16_384
        status = wait_thread.value
        error_output = stderr_thread.value
        result = JSON.parse(output)
        unless status.success? && result["status"] == "completed"
          detail = result["error"].to_s
          detail = error_output[0, 500] if detail.empty?
          raise ArgumentError, detail.empty? ? "CRuby ISeq inspection failed" : detail
        end
        return result
      end
    rescue Timeout::Error
      Process.kill("KILL", -wait_thread.pid) rescue nil
      wait_thread.join
      raise ArgumentError, "CRuby ISeq inspection exceeded its #{TIMEOUT_SECONDS} second limit"
    ensure
      if wait_thread.alive?
        Process.kill("KILL", -wait_thread.pid) rescue nil
        wait_thread.join
      end
      [stdout, stderr].each { |pipe| pipe.close rescue nil }
      stderr_thread.kill if stderr_thread.alive?
    end
  end
end

def run_process(command, stdin_data: nil, timeout_seconds:, max_output:)
  output = +""
  error_output = +""
  Open3.popen3(*command, pgroup: true) do |stdin, stdout, stderr, wait_thread|
    stdin.write(stdin_data) if stdin_data
    stdin.close
    stdout_thread = Thread.new do
      captured = +""
      while (chunk = stdout.read(8_192))
        remaining = (max_output + 1) - captured.bytesize
        captured << chunk.byteslice(0, remaining) if remaining.positive?
      end
      captured
    end
    stderr_thread = Thread.new { stderr.read(16_384) }
    begin
      Timeout.timeout(timeout_seconds) do
        status = wait_thread.value
        output = stdout_thread.value
        error_output = stderr_thread.value
        raise ArgumentError, "Analyzer output exceeded its limit" if output.bytesize > max_output
        return [status, output, error_output]
      end
    rescue Timeout::Error
      Process.kill("KILL", -wait_thread.pid) rescue nil
      wait_thread.join
      raise ArgumentError, "Analyzer subprocess exceeded its #{timeout_seconds} second limit"
    ensure
      if wait_thread.alive?
        Process.kill("KILL", -wait_thread.pid) rescue nil
        wait_thread.join
      end
      [stdin, stdout, stderr].each { |pipe| pipe.close rescue nil }
      [stdout_thread, stderr_thread].each { |thread| thread.kill if thread.alive? }
    end
  end
end

def run_reconstructor(disassembly_path)
  status, output, error_output = run_process(
    ["python3", DECOMPILE_WORKER, disassembly_path],
    timeout_seconds: DECOMPILE_TIMEOUT_SECONDS,
    max_output: MAX_RECONSTRUCTED_SOURCE + 32_768
  )
  result = JSON.parse(output)
  unless status.success? && result["status"] == "completed"
    detail = result["error"].to_s
    detail = error_output[0, 500] if detail.empty?
    raise ArgumentError, detail.empty? ? "Ruby source reconstruction failed" : detail
  end
  source = result["source"]
  raise ArgumentError, "Ruby reconstruction returned invalid source" unless source.is_a?(String) && source.bytesize.between?(1, MAX_RECONSTRUCTED_SOURCE)
  result
end

def ruby_syntax_check(source)
  status, output, error_output = run_process(
    [RbConfig.ruby, "-c", "-"],
    stdin_data: source,
    timeout_seconds: 8,
    max_output: 8_192
  )
  [status.success?, (output + error_output).strip[0, 1_000]]
rescue StandardError => error
  [false, error.message.to_s[0, 1_000]]
end

def save_derived_file(output_path, content)
  output_directory = File.dirname(output_path)
  FileUtils.mkdir_p(output_directory)
  resolved_directory = File.realpath(output_directory)
  raise ArgumentError, "Derived output directory escaped its storage root" unless resolved_directory.start_with?(DERIVED_ROOT + File::SEPARATOR)
  temp_path = File.join(resolved_directory, ".#{SecureRandom.hex(12)}.tmp")
  File.open(temp_path, File::WRONLY | File::CREAT | File::EXCL, 0o644) do |file|
    file.write(content)
    file.flush
    file.fsync
  end
  File.rename(temp_path, output_path)
end

def analyze(body)
  raise ArgumentError, "Request must be a JSON object" unless body.is_a?(Hash)
  project_id = safe_id(body["projectId"])
  artifact_id = safe_id(body["artifactId"])
  task_id = safe_id(body["taskId"])
  run_id = safe_id(body["runId"])
  relative_path = body["artifactRelativePath"]
  raise ArgumentError, "Artifact logical path is invalid" unless relative_path.is_a?(String) && relative_path.length.between?(1, 1000)
  input_path = resolve_input(body["artifactPath"])
  result = run_inspector(input_path)
  raise ArgumentError, "Input changed during inspection" unless Digest::SHA256.file(input_path).hexdigest == result["inputSha256"]

  source_name = File.basename(relative_path.tr("\\", "/"), File.extname(relative_path.tr("\\", "/")))
  basename = source_name.gsub(/[^A-Za-z0-9_.-]/, "_")[0, 120]
  basename = "module" if basename.nil? || basename.empty?
  source_key = Digest::SHA256.hexdigest(relative_path)[0, 16]
  output_relative = [project_id, artifact_id, task_id, run_id, "cruby-iseq", source_key, "#{basename}.yarv.disasm"].join("/")
  output_path = File.join(DERIVED_ROOT, *output_relative.split("/"))
  output_directory = File.dirname(output_path)
  save_derived_file(output_path, result.fetch("disassembly"))

  response = result.merge(
    toolVersion: "cruby-iseq-inspector@1",
    inputRelativePath: relative_path.tr("\\", "/"),
    outputRelativePath: output_relative,
    outputName: "#{basename}.yarv.disasm",
  ).reject { |key, _| key == "disassembly" }

  begin
    reconstructed = run_reconstructor(output_path)
    syntax_valid, syntax_message = ruby_syntax_check(reconstructed.fetch("source"))
    if syntax_valid
      reconstructed_relative = output_relative.sub(/\.yarv\.disasm\z/, ".reconstructed.rb")
      reconstructed_path = File.join(DERIVED_ROOT, *reconstructed_relative.split("/"))
      source = reconstructed.fetch("source")
      save_derived_file(reconstructed_path, source)
      response.merge!(
        reconstructionStatus: "syntax_validated_candidate",
        reconstructionRelativePath: reconstructed_relative,
        reconstructionName: "#{basename}.reconstructed.rb",
        reconstructionSha256: Digest::SHA256.hexdigest(source),
        reconstructionBytes: source.bytesize,
        reconstructionUpstream: reconstructed.fetch("upstream"),
        reconstructionUpstreamRevision: reconstructed.fetch("upstreamRevision"),
        reconstructionScope: reconstructed.fetch("upstreamScope"),
        reconstructionIseqCount: reconstructed.fetch("iseqCount"),
        reconstructionRootCount: reconstructed.fetch("rootCount"),
        reconstructionWarnings: reconstructed.fetch("warnings"),
        reconstructionSyntaxMessage: syntax_message
      )
    else
      response[:reconstructionStatus] = "syntax_rejected"
      response[:reconstructionWarning] = "Experimental source candidate failed CRuby #{RUBY_VERSION} syntax validation: #{syntax_message}"
    end
  rescue StandardError => error
    response[:reconstructionStatus] = "unavailable"
    response[:reconstructionWarning] = "Experimental Ruby source reconstruction unavailable: #{error.message.to_s[0, 500]}"
  end

  response
end

server = TCPServer.new("0.0.0.0", PORT)
busy = Mutex.new
warn "CRuby ISeq inspector listening on 0.0.0.0:#{PORT} with MRI #{RUBY_VERSION}"
loop do
  socket = server.accept
  Thread.new(socket) do |connection|
    begin
      method, path, body = read_request(connection)
      if method == "GET" && path == "/health"
        json_response(connection, 200, { status: "ok", rubyVersion: RUBY_DESCRIPTION })
      elsif method == "POST" && path == "/inspect"
        if !busy.try_lock
          json_response(connection, 429, { error: "CRuby ISeq inspector is busy" })
        else
          begin
            json_response(connection, 200, analyze(body))
          ensure
            busy.unlock
          end
        end
      else
        json_response(connection, 422, { error: "Unsupported request" })
      end
    rescue StandardError => error
      json_response(connection, 422, { error: error.message.to_s[0, 1000] }) rescue nil
    ensure
      connection.close rescue nil
    end
  end
end
