<div align="center">

<img src="./images/11.png" width="5%"/>

<h1 align="center">gshell — GShadow Terminal</h1>

AI-native terminal assistant. Watchful. Direct. Yours.

`gsh` is the command. The shell answers.

[Download](https://github.com/GShadow-Dev/gshell/releases) · [Docs](https://github.com/GShadow-Dev/gshell/wiki)

[![macOS](https://img.shields.io/badge/-macOS-black?logo=apple)](https://github.com/GShadow-Dev/gshell/releases)
[![Windows](https://img.shields.io/badge/-Windows-blue?logo=windows)](https://github.com/GShadow-Dev/gshell/releases)
[![Linux](https://img.shields.io/badge/-Linux-yellow?logo=linux)](https://github.com/GShadow-Dev/gshell/releases)

</div>

---

## What gshell is

gshell extends the GShadow digital shadow into your terminal. It watches your workflow, answers with evidence, and acts when you tell it to. Not a chatbot. Not a wrapper around someone else's API key form. A terminal-native agent that belongs to you.

Lead with the finding. Check the bodies. Move.

## Install

Download the latest from [releases](https://github.com/GShadow-Dev/gshell/releases).

```
gsh
```

That's it. The terminal assistant wakes.

## Capabilities

- **Shell-native.** gsh integrates with your terminal, not a browser tab. Pipe output in. Pipe decisions out.
- **Multi-model.** Route to the model that fits the task. No lock-in.
- **Context-aware.** gsh sees your working directory, git state, and shell history. It knows where you are.
- **Plugin system.** Extend with custom providers, tools, and workflows. Drop a plugin file. It loads.
- **Cross-platform.** macOS, Windows, Linux. One binary. Same behavior.
- **Local-first.** Your data stays on your machine unless you send it somewhere. gsh watches. It doesn't leak.

## Plugins

gshell loads plugins from `~/.gshell/plugins/`. A plugin is a single JS file that defines a provider:

```js
module.exports = {
  options: {
    myProvider: {
      displayName: 'My Provider',
      name: 'myProvider',
      url: 'https://api.example.com/chat',
      method: 'POST',
      type: 'plugin',
      headers: { 'Content-Type': 'application/json' },
      body: (messages) => JSON.stringify({ messages, stream: true }),
      fn: async function(controller, event, messages, message) {
        // Handle the stream
      }
    }
  }
}
```

See the [plugin development guide](https://github.com/GShadow-Dev/gshell/wiki/Plugins) for the full API.

## From the brand

gshell operates under the GShadow worldview:

- **Watchful, not paranoid.** It observes your terminal. It doesn't surveil.
- **Direct, not careless.** Short answers. Concrete next actions.
- **Independent, not oppositional.** It follows evidence, not popularity.
- **Strange with purpose, never random.** Violet trace in the void. One edge at a time.

> Green dashboards lie. I check the bodies.

## Build from source

```bash
git clone https://github.com/GShadow-Dev/gshell.git
cd gshell
npm install
npm run build
```

Requires Node.js 18+ and Electron 23+.

## License

MIT. GShadow brand assets and the NIGHTGRIN persona are property of Fincher Labs.
