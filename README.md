# seconv-kikoeru
A wrapper for [SubtitleEdit](https://github.com/SubtitleEdit/subtitleedit)'s [SeConv CLI](https://subtitleedit.github.io/subtitleedit/reference/command-line.html) tool that lets you batch-translate various lyric files. Originally created for use with Kikoeru but adjusted to work with any folder structure.

## Usage
**Requirement:** `seconv` (from [Subtitle Edit](https://github.com/SubtitleEdit/subtitleedit/releases)) in `lib/seconv/`. If it isn't there, click **Download latest pre-release** in the app. On Windows, the app also needs the [WebView2 runtime](https://developer.microsoft.com/microsoft-edge/webview2/) (part of Windows 11) and the Visual C++ 2015-2022 x64 runtime.

1) Download the latest release from [here](https://github.com/Makar8000/seconv-kikoeru/releases/latest) and extract it.
2) Run `seconv-kikoeru`.
3) Adjust the settings in the window (see [Configuration](#configuration)).
4) Ensure the server for your translation engine is running. For llama.cpp, this is taken care of for you (see [Local llama.cpp](#local-llamacpp))
5) Place the files you want to translate in the queue folder (or set another folder in the app)
6) Click **Start translation**. Progress (by line count) and log output are shown in the window.

Files will be translated in-place. Backups will be placed in a `.trans-metadata/backups` subfolder within each RJ folder, mirroring that folder's structure. Metadata about translated/failed files is stored in `.trans-metadata/manifest.json` within each RJ folder. Files that have already been successfully translated (or are already in their target language) will be skipped.

## Configuration
Settings are edited in the app and saved automatically to the loaded profile: a `.json` file in `profiles/`. The **Profile** dropdown in the header switches between profiles, and the **Profile** menu creates new ones (see [Menu](#menu)).

Three profiles are provided by default:
- `Local llama.cpp` - The local `llamacpp` engine with [Tencent's Hy-MT2](https://huggingface.co/tencent/Hy-MT2-7B-GGUF) (see [Local llama.cpp](#local-llamacpp)).
- `OpenRouter` - The `openai-compatible` engine with [OpenRouter](https://openrouter.ai/)'s [`~deepseek/deepseek-flash-latest`](https://openrouter.ai/~deepseek/deepseek-flash-latest) and a prompt for audio transcripts written for chat models. An OpenRouter API key is required.
- `0G Private Computer` - The `openai-compatible` engine with [0G Private Computer](https://pc.0g.ai/)'s [`glm-5.3`](https://pc.0g.ai/models/glm-5.3) and the same prompt. A 0GPC API key with trust mode set to Private is required.

The currently selected profile is saved to `settings.json`

### SeConv config
These are basic configurations sent to seconv. For more information on each option, please view their official documentation [here](https://subtitleedit.github.io/subtitleedit/reference/command-line.html)
- `translateEngine` - The engine to use for the translation: `llamacpp`, `openai-compatible`, `libretranslate` or `deepl`. Defaults to `llamacpp`.
- `translateFrom` - The language to translate from. Defaults to auto-detect per file.
- `translateTo` - The language to translate to. Defaults to English.
- `engines` - Settings for each translation engine. Every engine has its own entry, so switching engines in the app never loses what you set for another one. Only the selected `translateEngine` is used when translating. Each entry has:
  - `model` - The model to use. Only used by `llamacpp` and `openai-compatible`.
    - For `llamacpp`: a Hugging Face link to a `.gguf` file, or `user/repo` / `user/repo:quant`, downloaded into `lib/llama.cpp/models/` the first time; or the file name of a model in that folder. Defaults to `tencent/Hy-MT2-7B-GGUF:Q4_K_M` (Tencent's Hy-MT2 7B).
  - `url` - The url of the translation server. If empty, seconv's default for the engine is used.
    - For `llamacpp`: a llama.cpp server already running at this URL is used. Otherwise the app starts one there for the run (see [Local llama.cpp](#local-llamacpp)). Defaults to `http://127.0.0.1:8080/`.
  - `apiKey` - The API key for the translation service. Only used by `openai-compatible` and `deepl`. Stored in plain text in the profile's file.
  - `useCustomPrompt` - If `false`, `prompt` is kept but not sent, so seconv uses its own default prompt. Defaults to `true` for `llamacpp` and `openai-compatible`.
  - `prompt` - The translation prompt, or a path to a text file containing it. Only used by `llamacpp` and `openai-compatible`. `{0}` is the source language and `{1}` the target language. Keep it on one line. If empty, seconv's default prompt is used.
  - `temperature`, `topP`, `topK`, `repeatPenalty` - Only for `llamacpp`: the sampling settings of the llama-server the app starts. They default to Tencent's recommended values for Hy-MT2 (`0.7`, `0.6`, `20`, `1.05`); adjust them if you switch to another model. A blank or invalid value falls back to the default. A llama.cpp server that was already running at the URL keeps its own settings.
  - `additionalArgs` - For advanced use, a list of additional arguments to pass to the `seconv` process, e.g. `--settings:my-settings.json` to override seconv's own defaults (`seconv dump-settings` prints them). See the official documentation for more information.

### Local llama.cpp
When you click **Start translation** with the `llamacpp` engine, the app checks the server `url`:
1) If a llama.cpp server is already running there, it's used as it is.
2) Otherwise, the app downloads llama.cpp and the model if they're missing, starts `llama-server` on `127.0.0.1` at the URL's port, and stops it when the run ends, also when you click **Stop**.

Everything it starts comes from `lib/llama.cpp/`:
- `lib/llama.cpp/bin/` - `llama-server` and its libraries. On Windows, the newest [llama.cpp build](https://github.com/ggml-org/llama.cpp/releases) is downloaded here: the CUDA build with its CUDA runtime if an NVIDIA driver is installed, else the CPU build. On other systems, put the files of a llama.cpp release here yourself.
- `lib/llama.cpp/models/` - models downloaded from Hugging Face (in Hugging Face's folder layout), plus any `.gguf` you put here yourself.
- `lib/llama.cpp/config.ini` - created on first use and read by llama-server at startup. It turns off llama-server's web page and `/slots` endpoint, stops other websites from reading its responses, and blocks downloads. Keys are llama-server's command-line options without the leading `--`; the app's own flags (model, host, port, ...) take precedence.

### seconv-kikoeru config
- `name` - The profile's name, shown in the **Profile** menu and the window title.
- `rjPath` - The folder that contains all of your lyric/subtitle files that need to be translated. Searched recursively. Defaults to `./queue`.
- `subtitleExtensions` - The file extensions to parse. Defaults to `lrc`, `srt`, `vtt`.

## Menu
- **Profile → New** - Asks for a name, then creates a profile with the default settings and loads it.
- **Profile → Duplicate** - Asks for a name, then copies the loaded profile into a new one and loads it.
- **Profile → Rename** - Renames the loaded profile.
- **Profile → Delete** - Asks for confirmation, then deletes the loaded profile's file and loads the first profile left. The last profile can't be deleted.
- **Profile dropdown** (in the window's header) - Loads the selected profile. The loaded one's name is in the window title.
- **Tools → Update seconv** - Downloads the latest pre-release of seconv into `lib/seconv/`.
- **Tools → Update llama.cpp** - Downloads the latest llama.cpp release into `lib/llama.cpp/bin/` (Windows only, see [Local llama.cpp](#local-llamacpp)).
- **Tools → Restore backups** - Asks for confirmation, then restores every file in the `.trans-metadata/backups` subfolders under `rjPath` back to its original (pre-translation) content. Afterwards, each fully restored RJ folder's `.trans-metadata` folder is deleted.

The above menu options are unavailable while a translation, download or restore is already running.

## Running from source
This project requires [Bun](https://bun.com/) 1.4+.

1) `bun install`
2) `bun run dev` (runs the app, restarting it when a source file changes) or `bun run build` (builds the Windows app into `bin/seconv-kikoeru/`: the executable and the webview addon next to it)

`bun check` type-checks the project, `bun run lint` runs Biome and `bun run fix` applies its fixes.

The window is the system WebView, through [@webviewjs/webview](https://github.com/webviewjs/webview): WebView2 on Windows, WebKitGTK 4.1 on Linux, WebKit on macOS. The browser data it keeps (cache, cookies) goes to `.webview2/` inside the app folder.
