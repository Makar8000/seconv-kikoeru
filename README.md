# seconv-kikoeru
A wrapper for [SubtitleEdit](https://github.com/SubtitleEdit/subtitleedit)'s [SeConv CLI](https://subtitleedit.github.io/subtitleedit/reference/command-line.html) tool that lets you batch-translate various lyric files. Originally created for use with Kikoeru but adjusted to work with any folder structure.

## Usage
**Requirement:** `seconv` (from [Subtitle Edit](https://github.com/SubtitleEdit/subtitleedit/releases)) in `lib/seconv/`. If it isn't there, click **Download latest pre-release** in the app: it downloads the newest pre-release build for your OS/architecture (`SeConv-<OS>-<Arch>.zip` / `.tar.gz`) and extracts it to `lib/seconv/`, along with that version's list of translation languages for the language dropdowns. `lib/` is relative to the folder you launch the app from (like `config.json`).

1) Download the latest release from [here](https://github.com/Makar8000/seconv-kikoeru/releases/latest) and extract it.
2) Run `seconv-kikoeru`.
3) Adjust the settings in the window (see [Configuration](#configuration)) and click **Save config**.
4) Ensure the server for the translation engine specified in the config is running, or for llama.cpp, leave its server URL empty and put a model in `lib/llama.cpp/models/` (see [Local llama.cpp](#local-llamacpp))
5) Place the files you want to translate in the queue folder (or set another folder in the app)
6) Click **Start translation**. Progress (by file count) and log output are shown in the window.

Files will be translated in-place. Backups will be placed in a `.trans-metadata/backups` subfolder within each RJ folder, mirroring that folder's structure. Metadata about translated/failed files is stored in `.trans-metadata/manifest.json` within each RJ folder; files that have already been successfully translated will be skipped on subsequent runs.

## Configuration
Settings are edited in the app and saved to `config.json` in the working directory. If it doesn't exist on launch, it is created from `src/config/default-config.json`. You can also edit `config.json` by hand.

### SeConv config
These are basic configurations sent to seconv. For more information on each option, please view their official documentation [here](https://subtitleedit.github.io/subtitleedit/reference/command-line.html)
- `translateEngine` - The engine to use for the translation. See official documentation for possible options. Defaults to `llamacpp`.
- `translateFrom` - The language to translate from. Defaults to auto-detect per file.
- `translateTo` - The language to translate to. Defaults to English.
- `engines` - Settings for each translation engine. Every engine has its own entry, so switching engines in the app never loses what you set for another one. Only the selected `translateEngine` is used when translating. Each entry has:
  - `model` - The model to use. If empty, it will use the first available model. For `llamacpp` without a `url`, the file name of a model in `lib/llama.cpp/models/` (`.gguf` is optional).
  - `url` - The url of the translation server. If provided, the server must already be running.
    - For the `llamacpp` engine you can leave this empty: `seconv` then starts and stops llama-server from `lib/llama.cpp/` itself (see [Local llama.cpp](#local-llamacpp)).
  - `apiKey` - The API key for the translation service. Only used by `openai-compatible` and `deepl` (required for `deepl`). Stored in plain text in `config.json`.
  - `useCustomPrompt` - If `false`, `prompt` is kept but not sent, so seconv uses its own default prompt. Defaults to `true` for `llamacpp`, `ollama`, `lmstudio` and `openai-compatible`.
  - `prompt` - The translation prompt, or a path to a text file containing it. Only used by `llamacpp`, `ollama`, `lmstudio` and `openai-compatible`. `{0}` is the source language and `{1}` the target language. Keep it on one line. If empty, seconv's default prompt is used.
    - `llamacpp`, `ollama` and `lmstudio` default to a prompt for ASMR transcripts, written for general chat models.
    - `openai-compatible` defaults to the "style" prompt format that Tencent trained its default Hy-MT2 model on. If you switch it to a general chat model, copy the prompt from one of the other engines.
  - `additionalArgs` - For advanced use, a list of additional arguments to pass to the `seconv` process. See the official documentation for more information.

### Local llama.cpp
With the `llamacpp` engine and an empty `url`, everything comes from `lib/llama.cpp/`. Nothing on your PATH or in Subtitle Edit's own folders is used:
- `lib/llama.cpp/bin/` - `llama-server` and its libraries. On Windows, choosing `llamacpp` with an empty `url` downloads the newest [llama.cpp build](https://github.com/ggml-org/llama.cpp/releases) here if it's missing. **Tools → Update llama.cpp** replaces it with the newest one. On other systems, put the files of a llama.cpp release here yourself.
- `lib/llama.cpp/models/` - your `.gguf` models.
- `lib/llama.cpp/config.ini` - created on first use and read by llama-server at startup. It turns off llama-server's web page and `/slots` endpoint, stops other websites from reading its responses, and blocks downloads. Keys are llama-server's command-line options without the leading `--`; seconv's own flags (model, host, port, ...) take precedence.

Updating llama.cpp only replaces `bin/`; your models and `config.ini` are kept. seconv starts llama-server on a random `127.0.0.1` port for each batch of files and stops it afterwards, also when you click **Stop**. During a run, `lib/seconv/llama.cpp` is a link (a junction on Windows) to `lib/llama.cpp/bin`, so that seconv uses it instead of Subtitle Edit's own llama.cpp; the link is removed when the run ends, and only the link: deleting or updating `lib/seconv` never touches `lib/llama.cpp`. On drives that can't hold links (exFAT, FAT32), translation won't start while Subtitle Edit's own `%APPDATA%\Subtitle Edit\llama.cpp` folder exists, because seconv would use it instead.

### seconv-kikoeru config
- `rjPath` - The folder that contains all of your lyric/subtitle files that need to be translated. Searched recursively. Defaults to `./queue`.
- `subtitleExtensions` - The file extensions to parse. Defaults to `lrc`, `srt`, `vtt`.

## Menu
- **Tools → Update seconv** - Downloads the latest pre-release of seconv (and its language list) into `lib/seconv/`. `lib/llama.cpp/` is not touched.
- **Tools → Update llama.cpp** - Downloads the newest llama.cpp build into `lib/llama.cpp/bin/` (Windows only, see [Local llama.cpp](#local-llamacpp)). Models and `config.ini` are kept.
- **Tools → Restore backups** - Restores every file in the `.trans-metadata/backups` subfolders under `rjPath` back to its original (pre-translation) content. Afterwards, each fully restored RJ folder's `.trans-metadata` folder is deleted.

These are unavailable while a translation, download or restore is already running.

## Running from source
This project requires [deno](https://deno.com/) 2.9+ (uses `deno desktop` with the system WebView backend).

1) `deno install`
2) `deno task dev` (hot reload) or `deno task build` (outputs `bin/seconv-kikoeru/`)

### Tasks
- `deno task dev` - Runs the desktop app with hot module reload.
- `deno task build` - Builds the desktop app for the current platform.

On Linux, the WebView backend needs WebKitGTK.
