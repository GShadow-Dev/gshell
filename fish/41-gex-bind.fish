# gex enter bind — only rewrite natural-language `gex …` lines.
# Everything else (including heredocs / multi-line) uses normal fish execute.

if not status is-interactive
    exit
end

function __gex_protect_commandline --description 'Escape gex task as one fish string'
    # Never rewrite inside the autopilot-driven PTY
    if set -q GEX_AUTOPILOT
        return 0
    end

    set -l line (commandline | string collect)
    set -l trimmed (string trim -- $line)
    test -n "$trimmed"; or return 0

    # already protected: gex -- ...
    if string match -qr '^gex\s+--\s+' -- $trimmed
        return 0
    end

    # bare gex
    if string match -qr '^gex$' -- $trimmed
        return 0
    end

    # flags / subcommands keep normal parsing
    if string match -qr '^gex\s+(-h|--help|--max-steps(\s|=)|recall\b|log\b)' -- $trimmed
        return 0
    end

    if string match -qr '^gex\s+' -- $trimmed
        set -l rest (string replace -r '^gex\s+' '' -- $trimmed)
        test -n "$rest"; or return 0
        set -l esc (string escape --style=script -- $rest)
        commandline -r -- "gex -- $esc"
    end
    return 0
end

function __gex_bind_execute --description 'Enter: protect gex tasks only, else normal execute'
    # Autopilot PTY: never intercept — multi-line + heredocs must work
    if set -q GEX_AUTOPILOT
        commandline -f execute
        return
    end

    set -l buf (commandline | string collect)
    set -l trimmed (string trim -- $buf)

    # Only touch single-line gex invocations
    if string match -qr '^gex(\s|$)' -- $trimmed; and not string match -q '*\n*' -- $buf
        __gex_protect_commandline
    end

    commandline -f execute
end

bind \r __gex_bind_execute
bind \n __gex_bind_execute
