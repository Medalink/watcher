# Contributing to Watcher

Thanks for helping. Watcher is a small Windows app, and outside contributions are what make it better: bug reports, fixes, screenshots, documentation and new features are all welcome.

## Ways to help

- **Report a bug.** Open an [issue](https://github.com/Medalink/watcher/issues/new/choose) with your Windows build, `wslc --version`, what you did and what you saw. A screenshot or the Copy for AI report helps a lot.
- **Suggest a feature.** Open an issue that describes the problem first, then the change you have in mind.
- **Fix something.** Issues labeled `good first issue` are small and self-contained. Comment on one so nobody else picks it up at the same time.
- **Improve the docs.** If something in the README confused you, a pull request that fixes it is a great first contribution.

## Set up

You need Windows 11, WSL with container support (`wslc`), and the [.NET 10 SDK](https://dotnet.microsoft.com/download/dotnet/10.0).

```powershell
git clone https://github.com/Medalink/watcher.git
cd watcher
dotnet run -c Release
```

To try changes without touching your own history and preferences, point Watcher at a scratch data folder first:

```powershell
$env:WATCHER_DATA_FOLDER = "$env:TEMP\watcher-dev"
dotnet run -c Release
```

Only one Watcher runs per device, because each one watches every container on the machine. Close your everyday Watcher before starting a development build. Launching a second copy just brings the open one to the front.

## Project layout

- `*.cs` in the root is the WPF host: polling `wslc`, the SQLite store (`Store.cs`), activity events (`Activity.cs`, `ActivityTracker.cs`), resource limits (`Limits.cs`) and the bridge to the page (`MainWindow*.cs`).
- `web/` is the interface, plain ES modules served from disk into WebView2. Each page is one module (`containers.js`, `stats.js`, `activity.js`, `resources.js`, `management.js`), and `dom.js` holds the shared helpers.
- `web/vendor/signal/` is the vendored [Signal design kit](https://github.com/Medalink/signal-design). Don't edit it here. Its README explains how to refresh it.
- `tests/Watcher.Tests/` holds the xUnit tests.
- `tools/verify-management.ps1` drives the real app against a disposable container.

## Before you open a pull request

There is no hosted CI, so please run the checks yourself and paste the results into the pull request.

```powershell
dotnet build -c Release
dotnet test tests/Watcher.Tests -c Release
```

For changes to the interface, the bridge or management actions, also run the end-to-end check. It needs a cached `alpine:3.20` image (`wslc pull alpine:3.20`), and it creates and removes its own labeled container and volume. Close Watcher first, because the script starts its own:

```powershell
pwsh -NoProfile -File tools/verify-management.ps1
```

For any visible change, add a before and after screenshot to the pull request.

## Guidelines

- **One change per pull request.** Small pull requests get reviewed and merged quickly. Split refactors from behavior changes.
- **Match the surrounding code.** Follow the naming, idioms and comment density of the file you are editing. A comment should explain a non-obvious *why*, not restate the code.
- **Test behavior.** New logic gets a test that asserts what a user would observe. Put pure logic in testable classes (for example, `LimitEnforcer` takes a snapshot and returns breaches) rather than in the window code.
- **Follow the Signal design spec.** Use the kit's components and tokens as its showcase shows them. Text uses regular and medium weights only (`var(--font-weight-semibold)`), card titles go directly in `sd-card-head`, and the square `sd-dot` marks a status, never a heading.
- **Keep it local and safe.** Watcher sends nothing over the network on its own. Anything that stops, removes or overwrites must name its exact targets and ask for confirmation first.
- **Respect the scope.** Watcher manages containers that already exist. Creating containers, building images and launching Compose stacks are deliberately left out, so please open an issue to discuss before working on anything in that area.

## Pull request description

Say what changes for the user, what you deliberately left unchanged, and exactly what you ran to verify it: the test count, the verification script, the screenshots. The pull request template walks through this.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). Be kind and assume good intent.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
