# Heading Autolink Suggestions

Obsidian plugin that suggests note headings while typing normal text and inserts links like:

- `[[File#Heading]]`
- `[[File#Heading|Heading]]` (when alias setting is enabled)

## What it does

- Indexes headings from all markdown files via `metadataCache`
- Shows heading suggestions without typing `[[`
- Inserts heading links from the suggestion dropdown
- Supports partial + optional fuzzy matching

## Build

```bash
npm install
npm run build
```

## Install

1. Build the plugin.
2. Copy `main.js`, `manifest.json`, `versions.json` to:
   - `<vault>/.obsidian/plugins/auto-headers/`
3. Enable the plugin in **Settings -> Community plugins**.

## Main settings

- `Minimum characters before suggestions`
- `Enable fuzzy matching`
- `Case-sensitive matching`
- `Insert link alias`
- `Compatibility with other suggesters`
- `Debug logging`

## With Various Complements (VC)

- Turn on `Compatibility with other suggesters`.
- Assign a hotkey to command:
  - `Heading Autolink Suggestions: Trigger heading autolink suggestions`
- Behavior:
  - If VC popup is open, this plugin waits.
  - If no other popup is open, this plugin auto-suggests normally.
