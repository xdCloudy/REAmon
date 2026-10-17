using System.Text.Json;
using ICSharpCode.CodeConverter;
using Microsoft.CodeAnalysis;
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

    using var document = JsonDocument.Parse(input.ToArray());
    if (!document.RootElement.TryGetProperty("sources", out var sourceArray)
        || sourceArray.ValueKind != JsonValueKind.Array
        || sourceArray.GetArrayLength() > maxFiles)
    {
        Console.WriteLine(JsonSerializer.Serialize(new { error = "Invalid or oversized source list" }));
        return 2;
    }

    var translated = new List<object>();
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

        var inputBytes = System.Text.Encoding.UTF8.GetByteCount(code);
        totalInputBytes += inputBytes;
        if (inputBytes > 2 * 1024 * 1024 || totalInputBytes > maxInputBytes)
        {
            skipped++;
            continue;
        }

        try
        {
            var request = new CodeWithOptions(code).WithTypeReferences();
            var result = await ICSharpCode.CodeConverter.CodeConverter.ConvertAsync(request);
            if (!result.Success || string.IsNullOrWhiteSpace(result.ConvertedCode))
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
            translated.Add(new { relativePath, sourceCode = result.ConvertedCode });
        }
        catch
        {
            // A failed file remains available as the primary ILSpy C# output.
            skipped++;
        }
    }

    Console.WriteLine(JsonSerializer.Serialize(new { sources = translated, skipped }));
    return 0;
}
catch
{
    Console.WriteLine(JsonSerializer.Serialize(new { error = "The VB translation request could not be processed" }));
    return 1;
}
