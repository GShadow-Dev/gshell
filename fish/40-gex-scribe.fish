# gex room scribe — user commands between summons
# Disable: set -gx GEX_SCRIBE 0

if not status is-interactive
    exit
end
if test "$GEX_SCRIBE" = 0
    exit
end

function __gex_scribe_preexec --on-event fish_preexec
    set -l cmd $argv[1]
    test -n "$cmd"; or return
    string match -qr '^gex(\s|$)' -- $cmd; and return
    set -g __gex_scribe_cmd $cmd
    set -g __gex_scribe_t0 (date +%s)
end

function __gex_scribe_postexec --on-event fish_postexec
    set -l cmd $__gex_scribe_cmd
    set -e __gex_scribe_cmd
    test -n "$cmd"; or return
    string match -qr '^gex(\s|$)' -- $cmd; and return

    set -l code $status
    set -l t0 $__gex_scribe_t0
    set -l now (date +%s)
    set -l dur 0
    test -n "$t0"; and set dur (math $now - $t0)

    set -l tty_name (tty 2>/dev/null | string replace -a '/' '_')
    test -n "$tty_name"; or set tty_name unknown
    set -l side $HOME/.cache/gex/scribe/$tty_name.ndjson
    mkdir -p $HOME/.cache/gex/scribe

    set -l b64 (printf '%s' $cmd | base64 | tr -d '\n')
    set -l cwd_b64 (printf '%s' $PWD | base64 | tr -d '\n')
    set -l ts (date +%s000)
    printf '{"ts":%s,"kind":"user_cmd","actor":"user","cmd_b64":"%s","cwd_b64":"%s","exit":%s,"duration_s":%s,"pid":%s}\n' \
        $ts $b64 $cwd_b64 $code $dur $fish_pid >>$side 2>/dev/null
end
