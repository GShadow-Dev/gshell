# gex enter bind — everything after `gex` becomes one literal task string.
# Apostrophes in natural language never break fish parsing.

if not status is-interactive
    exit
end

function __gex_protect_commandline --description 'Escape gex task as one fish string'
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
        # script-style escape includes surrounding quotes
        set -l esc (string escape --style=script -- $rest)
        commandline -r -- "gex -- $esc"
    end
    return 0
end

function __gex_bind_execute --description 'Enter: protect gex then execute'
    __gex_protect_commandline
    commandline -f execute
end

bind \r __gex_bind_execute
bind \n __gex_bind_execute
