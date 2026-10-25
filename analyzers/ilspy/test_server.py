import json
import os
import shutil
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import server


class FakeProcess:
    pid = os.getpid()
    returncode = 0

    def poll(self):
        return 0

    def wait(self, timeout=None):
        return 0


class IlspyServiceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="reamon-ilspy-tests-")
        self.version_environment = patch.dict(os.environ, {"ILSPY_VERSION": "11.1.0.9782"})
        self.version_environment.start()
        self.root = Path(self.temporary.name)
        self.artifacts = self.root / "artifacts"
        self.derived = self.root / "derived"
        self.artifacts.mkdir()
        self.assembly = self.artifacts / "Example.dll"
        self.assembly.write_bytes(b"managed test assembly")
        server.ARTIFACT_ROOT = self.artifacts.resolve()
        server.DERIVED_ROOT = self.derived.resolve()

    def tearDown(self):
        self.temporary.cleanup()
        self.version_environment.stop()

    def request(self):
        return {
            "projectId": "project-1", "artifactId": "artifact-1", "taskId": "task-1",
            "runId": "run-1", "artifactPath": str(self.assembly),
        }

    def unchanged_preprocessing(self, input_path, *_args, **_kwargs):
        return Path(input_path), {"status": "unchanged", "inputSha256": server.sha256_file(input_path)}

    def emit_sources(self, args, **_kwargs):
        output = Path(args[args.index("-o") + 1])
        if "--ilcode" in args:
            output.mkdir(parents=True, exist_ok=True)
            (output / f"{self.assembly.stem}.il").write_text(".method public static void Main() {\n}\n", encoding="utf-8")
            return FakeProcess()
        (output / "Example" / "App").mkdir(parents=True)
        (output / "Example" / "App" / "Service.cs").write_text("namespace Example.App;\npublic class Service {}\n")
        (output / "Example" / "Model").mkdir(parents=True)
        (output / "Example" / "Model" / "Item.cs").write_text("namespace Example.Model { public record Item; }\n")
        return FakeProcess()

    def test_rejects_input_outside_artifact_volume(self):
        outside = self.root / "outside.dll"
        outside.write_bytes(b"not an imported artifact")
        with self.assertRaisesRegex(server.AnalysisError, "outside"):
            server.resolve_input(str(outside))

    def test_rejects_path_traversal_in_task_ids(self):
        with self.assertRaises(server.AnalysisError):
            server.safe_id("../outside")

    def test_decompiles_managed_assembly_and_stores_bounded_csharp_units(self):
        request = self.request()
        progress = []
        with patch.object(server, "preprocess_dotnet", side_effect=self.unchanged_preprocessing), \
                patch.object(server, "translate_csharp_to_vb", return_value=([], 0, None)), \
                patch.object(server.subprocess, "Popen", side_effect=self.emit_sources):
            result = server.analyse(request, report_progress=progress.append)

        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["toolVersion"], "11.1.0.9782")
        self.assertEqual(result["classCount"], 2)
        self.assertEqual(result["returnedUnits"], 2)
        self.assertFalse(result["truncated"])
        self.assertEqual({unit["language"] for unit in result["units"]}, {"C#"})
        self.assertIn("Example.App.Service", [unit["name"] for unit in result["units"]])
        self.assertTrue(all((self.derived / unit["codeArtifactId"]).is_file() for unit in result["units"]))
        self.assertTrue(any("Decompiling managed assembly" in message for message in progress))

    def test_limits_returned_units_and_reports_the_partial_result(self):
        with patch.object(server, "preprocess_dotnet", side_effect=self.unchanged_preprocessing), \
                patch.object(server, "translate_csharp_to_vb", return_value=([], 0, None)), \
                patch.object(server, "MAX_RETURNED_UNITS", 1), \
                patch.object(server.subprocess, "Popen", side_effect=self.emit_sources):
            result = server.analyse(self.request())

        self.assertEqual(result["classCount"], 2)
        self.assertEqual(result["returnedUnits"], 1)
        self.assertTrue(result["truncated"])
        self.assertIn("Only the first 1 of 2 discovered C# source files", result["warnings"])

    def test_marks_discovery_count_unknown_if_source_scan_hits_its_bound(self):
        with patch.object(server, "preprocess_dotnet", side_effect=self.unchanged_preprocessing), \
                patch.object(server, "translate_csharp_to_vb", return_value=([], 0, None)), \
                patch.object(server, "MAX_SOURCE_FILES", 1), \
                patch.object(server.subprocess, "Popen", side_effect=self.emit_sources):
            result = server.analyse(self.request())

        self.assertIsNone(result["classCount"])
        self.assertTrue(result["truncated"])
        self.assertIn("source scan stopped at its configured limit", result["warnings"])

    def test_persists_visual_basic_as_hash_linked_translation_units(self):
        vb_source = "Namespace Example.App\n    Public Class Service\n    End Class\nEnd Namespace\n"
        with patch.object(server, "preprocess_dotnet", side_effect=self.unchanged_preprocessing), \
                patch.object(server, "translate_csharp_to_vb", return_value=([("Example/App/Service.cs", vb_source)], 0, None)), \
                patch.object(server.subprocess, "Popen", side_effect=self.emit_sources):
            result = server.analyse(self.request())

        csharp = next(unit for unit in result["units"] if unit["relativePath"] == "Example/App/Service.cs")
        visual_basic = next(unit for unit in result["units"] if unit["relativePath"] == "visual-basic/Example/App/Service.vb")
        vb_path = self.derived / visual_basic["codeArtifactId"]

        self.assertEqual(result["vbBridgeVersion"], server.VB_BRIDGE_VERSION)
        self.assertEqual(result["returnedUnits"], 3)
        self.assertEqual(visual_basic["language"], "Visual Basic")
        self.assertEqual(visual_basic["decompiler"], "ICSharpCode.CodeConverter")
        self.assertEqual(visual_basic["derivedFromRelativePath"], csharp["relativePath"])
        self.assertEqual(visual_basic["derivedFromSha256"], csharp["sourceSha256"])
        self.assertEqual(visual_basic["sourceSha256"], server.sha256_file(vb_path))
        self.assertEqual(vb_path.read_text(encoding="utf-8"), vb_source)
        self.assertIn("not recovered original Visual Basic source", visual_basic["representationSemantics"])
        self.assertIn("not recovered original-language source", result["warnings"])

    def test_ilspy_reconstruction_translates_and_preserves_fixture_behavior(self):
        bridge = Path(os.environ.get("REAMON_VB_BRIDGE", "/opt/reamon-vb-bridge/Reamon.VbBridge.dll"))
        ilspy = Path(os.environ.get("ILSPYCMD", "/opt/ilspycmd/ilspycmd"))
        dotnet = os.environ.get("DOTNET", "dotnet")
        if not bridge.is_file() or not ilspy.is_file() or not shutil.which(dotnet):
            self.skipTest("The pinned ILSpy and Visual Basic bridge with the .NET SDK are required")

        source = self.artifacts / "managed-fixture"
        source.mkdir()
        (source / "Fixture.csproj").write_text("""<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
  </PropertyGroup>
</Project>
""", encoding="utf-8")
        (source / "Calculator.cs").write_text("""namespace Fixture
{
    public sealed class Calculator
    {
        private readonly int _bias;
        public Calculator(int bias) { _bias = BiasProvider.Normalize(bias); }
        public int Compute(int input)
        {
            int total = 0;
            for (int i = 0; i < input; i++) total += i;
            return total + _bias;
        }
    }
}
""", encoding="utf-8")
        (source / "BiasProvider.cs").write_text("""namespace Fixture
{
    public static class BiasProvider
    {
        public static int Normalize(int value) => value + 1;
    }
}
""", encoding="utf-8")
        environment = {**os.environ, "DOTNET_CLI_TELEMETRY_OPTOUT": "1", "DOTNET_NOLOGO": "1"}
        build = subprocess.run(
            [dotnet, "build", str(source / "Fixture.csproj"), "--configuration", "Release", "--nologo", "--verbosity", "quiet"],
            cwd=source, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=60, check=False, env=environment,
        )
        self.assertEqual(build.returncode, 0, build.stdout.decode("utf-8", errors="replace")[-3000:])
        assembly = source / "bin" / "Release" / "net10.0" / "Fixture.dll"
        self.assertTrue(assembly.is_file())
        request = self.request()
        request["artifactPath"] = str(assembly)
        with patch.object(server, "preprocess_dotnet", side_effect=self.unchanged_preprocessing):
            analysis = server.analyse(request)

        self.assertEqual(analysis["status"], "completed")
        self.assertEqual(analysis["vbBridgeVersion"], server.VB_BRIDGE_VERSION)
        visual_basic = [unit for unit in analysis["units"] if unit["language"] == "Visual Basic"]
        self.assertTrue(visual_basic, analysis["warnings"])

        project = self.root / "vb-fixture"
        project.mkdir()
        (project / "Fixture.vbproj").write_text("""<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <RootNamespace>ReamonVbFixture</RootNamespace>
    <GenerateAssemblyInfo>false</GenerateAssemblyInfo>
  </PropertyGroup>
</Project>
""", encoding="utf-8")
        for unit in visual_basic:
            relative = Path(unit["relativePath"])
            self.assertEqual(relative.parts[0], "visual-basic")
            destination = project.joinpath(*relative.parts[1:])
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes((self.derived / unit["codeArtifactId"]).read_bytes())
        (project / "Program.vb").write_text("""Module Program
    Sub Main()
        Dim actual = New ReamonVbFixture.Fixture.Calculator(3).Compute(5)
        If actual <> 14 Then Throw New System.Exception("translated behavior changed")
    End Sub
End Module
""", encoding="utf-8")
        result = subprocess.run(
            [dotnet, "run", "--project", str(project / "Fixture.vbproj"), "--configuration", "Release", "--nologo"],
            cwd=project, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=60, check=False, env=environment,
        )
        self.assertEqual(result.returncode, 0, result.stdout.decode("utf-8", errors="replace")[-3000:])

    def test_vb_origin_fixture_round_trips_through_ilspy_and_bridge(self):
        bridge = Path(os.environ.get("REAMON_VB_BRIDGE", "/opt/reamon-vb-bridge/Reamon.VbBridge.dll"))
        ilspy = Path(os.environ.get("ILSPYCMD", "/opt/ilspycmd/ilspycmd"))
        dotnet = os.environ.get("DOTNET", "dotnet")
        if not bridge.is_file() or not ilspy.is_file() or not shutil.which(dotnet):
            self.skipTest("The pinned ILSpy and Visual Basic bridge with the .NET SDK are required")

        source = self.artifacts / "vb-origin-fixture"
        source.mkdir()
        (source / "Fixture.vbproj").write_text("""<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <RootNamespace>Fixture</RootNamespace>
  </PropertyGroup>
</Project>
""", encoding="utf-8")
        (source / "Calculator.vb").write_text("""Public NotInheritable Class Calculator
    Private ReadOnly _bias As Integer
    Public Sub New(bias As Integer)
        _bias = bias
    End Sub
    Public Function Compute(input As Integer) As Integer
        Dim total As Integer = 0
        For i As Integer = 0 To input - 1
            total += i
        Next
        Return total + _bias
    End Function
End Class
""", encoding="utf-8")
        environment = {**os.environ, "DOTNET_CLI_TELEMETRY_OPTOUT": "1", "DOTNET_NOLOGO": "1"}
        build = subprocess.run(
            [dotnet, "build", str(source / "Fixture.vbproj"), "--configuration", "Release", "--nologo", "--verbosity", "quiet"],
            cwd=source, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=60, check=False, env=environment,
        )
        self.assertEqual(build.returncode, 0, build.stdout.decode("utf-8", errors="replace")[-3000:])
        assembly = source / "bin" / "Release" / "net10.0" / "Fixture.dll"
        self.assertTrue(assembly.is_file())
        request = self.request()
        request["artifactPath"] = str(assembly)
        with patch.object(server, "preprocess_dotnet", side_effect=self.unchanged_preprocessing):
            analysis = server.analyse(request)

        self.assertEqual(analysis["status"], "completed")
        visual_basic = [unit for unit in analysis["units"] if unit["language"] == "Visual Basic"]
        self.assertTrue(visual_basic, analysis["warnings"])

        project = self.root / "vb-origin-round-trip"
        project.mkdir()
        (project / "Fixture.vbproj").write_text("""<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <RootNamespace>ReamonVbFixture</RootNamespace>
    <GenerateAssemblyInfo>false</GenerateAssemblyInfo>
  </PropertyGroup>
</Project>
""", encoding="utf-8")
        for unit in visual_basic:
            relative = Path(unit["relativePath"])
            self.assertEqual(relative.parts[0], "visual-basic")
            destination = project.joinpath(*relative.parts[1:])
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes((self.derived / unit["codeArtifactId"]).read_bytes())
        (project / "Program.vb").write_text("""Module Program
    Sub Main()
        Dim actual = New ReamonVbFixture.Fixture.Calculator(4).Compute(5)
        If actual <> 14 Then Throw New System.Exception("VB-origin behavior changed")
    End Sub
End Module
""", encoding="utf-8")
        result = subprocess.run(
            [dotnet, "run", "--project", str(project / "Fixture.vbproj"), "--configuration", "Release", "--nologo"],
            cwd=project, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=60, check=False, env=environment,
        )
        self.assertEqual(result.returncode, 0, result.stdout.decode("utf-8", errors="replace")[-3000:])

    def test_health_endpoint_reports_pinned_ilspy_version(self):
        from http.server import ThreadingHTTPServer
        from threading import Thread
        import http.client

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        thread = Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            connection = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=2)
            connection.request("GET", "/health")
            response = connection.getresponse()
            payload = json.loads(response.read())
            self.assertEqual(response.status, 200)
            self.assertEqual(payload, {"status": "ready", "provider": "ilspy", "version": "11.1.0.9782"})
            connection.close()
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join(timeout=2)

class ResultChunkStreamTests(unittest.TestCase):
    def test_large_result_arrays_are_split_into_bounded_events(self):
        units = [{"id": index} for index in range(server.STREAM_RESULT_CHUNK_SIZE * 2 + 1)]
        events = list(server.stream_result_events({"status": "completed", "units": units, "warnings": ""}))

        self.assertEqual(events[0], {"type": "result_start", "data": {"status": "completed", "warnings": ""}, "arrayFields": ["units"]})
        chunks = [event["items"] for event in events if event["type"] == "result_chunk"]
        self.assertEqual([len(chunk) for chunk in chunks], [100, 100, 1])
        self.assertEqual([unit for chunk in chunks for unit in chunk], units)
        self.assertEqual(events[-1], {"type": "result_end"})

    def test_result_chunks_are_bounded_by_bytes_even_below_the_item_limit(self):
        units = [{"id": index, "detail": "x" * (24 * 1024)} for index in range(80)]
        events = list(server.stream_result_events({"status": "completed", "units": units, "warnings": ""}))

        self.assertEqual(events[0]["type"], "result_start")
        self.assertTrue(all(len(json.dumps(event, separators=(",", ":")).encode("utf-8")) <= server.STREAM_RESULT_CHUNK_BYTES for event in events))
        chunks = [event["items"] for event in events if event["type"] == "result_chunk"]
        self.assertEqual([unit for chunk in chunks for unit in chunk], units)


if __name__ == "__main__":
    unittest.main()
