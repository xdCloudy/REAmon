using System.Text.Json;
using ICSharpCode.CodeConverter.Common;
using ICSharpCode.CodeConverter.VB;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Text;
using Microsoft.CodeAnalysis.VisualBasic;

const int maxInputBytes = 8 * 1024 * 1024;
const int maxFiles = 200;
const int maxOutputBytes = 16 * 1024 * 1024;

try
{
    using var input = new MemoryStream();
    await Console.OpenStandardInput().CopyToAsync(input);
    if (input.Length > maxInputBytes + 64 * 1024)
    {
        Console.WriteLine(JsonSerializer.Serialize(new { error = "Input exceeds the VB translation limit" }));
        return 2;
    }

    using var inputDocument = JsonDocument.Parse(input.ToArray());
    if (!inputDocument.RootElement.TryGetProperty("sources", out var sourceArray)
        || sourceArray.ValueKind != JsonValueKind.Array
        || sourceArray.GetArrayLength() > maxFiles)
    {
        Console.WriteLine(JsonSerializer.Serialize(new { error = "Invalid or oversized source list" }));
        return 2;
    }

    var projectId = ProjectId.CreateNewId("ReamonVbBridge");
    var projectRoot = Path.Combine(Path.GetTempPath(), "reamon-vb-bridge-input");
    var references = GetPlatformReferences();
    using var workspace = new AdhocWorkspace();
    workspace.AddProject(ProjectInfo.Create(
        projectId,
        VersionStamp.Create(),
        "ReamonVbBridgeInput",
        "ReamonVbBridgeInput",
        LanguageNames.CSharp,
        compilationOptions: new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary),
        parseOptions: CSharpParseOptions.Default,
        metadataReferences: references));

    var sourcePaths = new Dictionary<string, string>(StringComparer.Ordinal);
    var documents = new List<Document>();
    var skipped = 0;
    var totalInputBytes = 0;
    var totalOutputBytes = 0;
    foreach (var source in sourceArray.EnumerateArray())
    {
        var relativePath = source.TryGetProperty("relativePath", out var pathElement) ? pathElement.GetString() : null;
        var code = source.TryGetProperty("sourceCode", out var codeElement) ? codeElement.GetString() : null;
        if (string.IsNullOrWhiteSpace(relativePath) || code is null)
        {
            skipped++;
            continue;
        }

        var pathSegments = relativePath.Replace('\\', '/').Split('/');
        if (Path.IsPathRooted(relativePath) || pathSegments.Any(segment => segment is "" or "." or ".."))
        {
            skipped++;
            continue;
        }

        var inputBytes = System.Text.Encoding.UTF8.GetByteCount(code);
        if (inputBytes > 2 * 1024 * 1024 || totalInputBytes + inputBytes > maxInputBytes)
        {
            skipped++;
            continue;
        }
        totalInputBytes += inputBytes;

        var sourcePath = Path.GetFullPath(Path.Combine(projectRoot, Path.Combine(pathSegments)));
        var projectRootWithSeparator = Path.GetFullPath(projectRoot) + Path.DirectorySeparatorChar;
        if (!sourcePath.StartsWith(projectRootWithSeparator, StringComparison.Ordinal))
        {
            skipped++;
            continue;
        }

        var documentId = DocumentId.CreateNewId(projectId, Path.GetFileName(relativePath));
        var documentInfo = DocumentInfo.Create(
            documentId,
            Path.GetFileName(relativePath),
            loader: TextLoader.From(TextAndVersion.Create(SourceText.From(code), VersionStamp.Create())),
            filePath: sourcePath);
        workspace.AddDocument(documentInfo);
        sourcePaths[sourcePath] = relativePath;
    }

    documents.AddRange(workspace.CurrentSolution.GetProject(projectId)!.Documents);
    var convertedSources = new List<object>();
    if (documents.Count > 0)
    {
        await foreach (var result in ProjectConversion.ConvertDocumentsAsync<CSToVBConversion>(documents, new ConversionOptions()))
        {
            if (!result.Success || string.IsNullOrWhiteSpace(result.ConvertedCode)
                || result.SourcePathOrNull is null
                || !sourcePaths.TryGetValue(result.SourcePathOrNull, out var relativePath))
            {
                skipped++;
                continue;
            }

            var syntax = VisualBasicSyntaxTree.ParseText(result.ConvertedCode);
            if (syntax.GetDiagnostics().Any(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error))
            {
                skipped++;
                continue;
            }

            var outputBytes = System.Text.Encoding.UTF8.GetByteCount(result.ConvertedCode);
            if (outputBytes > 2 * 1024 * 1024 || totalOutputBytes + outputBytes > maxOutputBytes)
            {
                skipped++;
                continue;
            }

            totalOutputBytes += outputBytes;
            convertedSources.Add(new { relativePath, sourceCode = result.ConvertedCode });
        }
    }

    Console.WriteLine(JsonSerializer.Serialize(new { sources = convertedSources, skipped }));
    return 0;
}

catch
{
    Console.WriteLine(JsonSerializer.Serialize(new { error = "The VB translation request could not be processed" }));
    return 1;
}

static IReadOnlyCollection<PortableExecutableReference> GetPlatformReferences()
{
    var paths = (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string ?? "")
        .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries)
        .Where(File.Exists)
        .Distinct(StringComparer.Ordinal)
        .Take(512);
    return paths.Select(path => MetadataReference.CreateFromFile(path)).ToArray();
}
