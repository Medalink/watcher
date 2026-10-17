using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Watcher;

/// <summary>
/// The optional settings.json in the data folder: which container labels name a folder and which name a section.
/// The first label present on a container wins.
/// </summary>
public sealed record Settings(IReadOnlyList<string> PathLabels, IReadOnlyList<string> GroupLabels)
{
    public static readonly Settings Default = new(["watcher.path"], ["watcher.group", "com.docker.compose.project"]);

    public static Settings Load(string file)
    {
        try
        {
            return Parse(File.ReadAllText(file));
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            return Default;
        }
    }

    /// <summary>A missing key, a value that is not a list of strings, or bad JSON falls back to that key's default.</summary>
    public static Settings Parse(string json)
    {
        JsonObject? root;
        try
        {
            root = JsonNode.Parse(json) as JsonObject;
        }
        catch (JsonException)
        {
            return Default;
        }

        return new Settings(Labels(root?["pathLabels"]) ?? Default.PathLabels, Labels(root?["groupLabels"]) ?? Default.GroupLabels);
    }

    private static string[]? Labels(JsonNode? node) =>
        node is JsonArray array && array.All(item => item?.GetValueKind() == JsonValueKind.String)
            ? array.Select(item => item!.GetValue<string>()).ToArray()
            : null;
}
