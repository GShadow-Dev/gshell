function gex --description 'gShell terminal autopilot — Gengar drives Ghostty'
    set -l gex_js /Users/james/Documents/gshell/bin/gex.js
    if not test -f $gex_js
        set_color '#ff5d45'
        echo "gex: missing $gex_js — cd gshell && npm install"
        set_color normal
        return 1
    end
    if not test -d (dirname $gex_js)/../node_modules/node-pty
        set_color '#ffb454'
        echo 'gex: installing node-pty…'
        set_color normal
        npm --prefix (dirname $gex_js)/.. install
        or return 1
    end

    set -gx GEX_PARENT_PID $fish_pid
    history merge 2>/dev/null

    # Strip protective -- from enter-bind rewrite
    if test (count $argv) -ge 1; and test "$argv[1]" = --
        set -e argv[1]
    end

    # Subcommands keep real argv splitting
    if test (count $argv) -ge 1
        switch $argv[1]
            case -h --help recall log
                command node $gex_js $argv
                set -l code $status
                history merge 2>/dev/null
                return $code
        end
    end

    # Everything else is ONE task string (quotes/apostrophes safe)
    set -l task (string join -- ' ' $argv)
    command node $gex_js -- $task
    set -l code $status

    history merge 2>/dev/null
    return $code
end
