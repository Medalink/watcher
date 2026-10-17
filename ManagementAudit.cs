using System.Text.Json;
using System.Text.Json.Nodes;

namespace Watcher;

public static class ManagementAudit
{
    public static ActivityEvent Interrupted(long at, string operation, JsonElement parameters, string session)
    {
        var error = new OperationCanceledException("Watcher exited while this request was in progress. Its outcome is unknown; it may not have been dispatched. Check the runtime and any transfer destination before retrying.");
        var activity = Event(at, operation, parameters, session, error);
        activity.Detail!["outcome"] = "interrupted";
        if (operation is "copy" or "image-save" or "volume-backup")
        {
            var key = operation == "copy" ? "hostPath" : "path";
            activity.Detail["possiblePartialOutput"] = operation == "copy" && activity.Detail["direction"]?.ToString() == "in"
                ? $"{activity.Detail["target"]}:{activity.Detail["containerPath"]}"
                : activity.Detail[key]?.ToString();
        }
        return activity with { Summary = $"{operation} interrupted by Watcher exit; outcome unknown" };
    }

    public static bool Includes(string operation) => operation is "object-remove" or "network-connect" or "copy" or "image-save" or "volume-backup" or "session-terminate";

    public static ActivityEvent Event(long at, string operation, JsonElement parameters, string session, Exception? error = null)
    {
        string? Text(string key) => parameters.ValueKind == JsonValueKind.Object && parameters.TryGetProperty(key, out var value)
            && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
        var container = operation switch
        {
            "copy" or "network-connect" => Text("name"),
            "volume-backup" => Text("container"),
            _ => null,
        };
        var kind = operation switch
        {
            "object-remove" => Text("kind"), "image-save" => "image", "volume-backup" => "volume",
            "session-terminate" => "session", _ => "container",
        };
        var target = operation == "session-terminate" ? (session.Length == 0 ? "default" : session) : Text("name");
        var outcome = error is null ? "ok" : error is OperationCanceledException ? "cancelled"
            : error.Data.Contains("actionSent") ? "failed" : "rejected";
        var detail = new JsonObject { ["op"] = operation, ["ok"] = error is null, ["outcome"] = outcome,
            ["kind"] = kind, ["target"] = target, ["session"] = session };
        foreach (var key in new[] { "container", "containerPath", "hostPath", "path", "direction", "network", "overwrite", "disconnect" })
            if (parameters.ValueKind == JsonValueKind.Object && parameters.TryGetProperty(key, out var value)) detail[key] = JsonNode.Parse(value.GetRawText());
        if (error is not null)
        {
            detail["error"] = error.Message[..Math.Min(2000, error.Message.Length)];
            if (error.Data["partialOutput"] is string path) detail["partialOutput"] = path;
        }
        return new(at, ActivityKind.Action, container, $"{operation} {outcome}: {kind} {target}", detail);
    }
}
