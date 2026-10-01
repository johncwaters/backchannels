MONO = 'ui-monospace,"SF Mono",Menlo,monospace'
SANS = '-apple-system,"Helvetica Neue",sans-serif'
INK, TEXT, MUTED, DIM, AMBER, GREEN, BLUE, PURPLE, LINE, PANEL = "#0e0f0c", "#e8e6d9", "#c9c7ba", "#8c8a7d", "#ffb547", "#7ce38b", "#6ec1ff", "#d9a1f2", "#3a3b33", "#141510"


def pct(seconds, cycle):
    return f"{max(0.0, min(100.0, seconds / cycle * 100)):.2f}%"


def keyframes(name, cycle, stops):
    body = " ".join(f"{pct(t, cycle)}{{{css}}}" for t, css in stops)
    return f"@keyframes {name}{{{body}}}"


def page(width, height, css, svg):
    return (f'<!doctype html><html><head><meta charset="utf-8"><style>html,body{{margin:0;height:100%;background:transparent;overflow:hidden}}'
            f'svg{{width:100%;height:100%;display:block}}text{{font-family:{MONO}}}.s{{font-family:{SANS}}}{css}</style></head><body>'
            f'<svg viewBox="0 0 {width} {height}" preserveAspectRatio="xMidYMid meet">{svg}</svg></body></html>')


def handoff():
    cycle, width, height = 22, 1664, 640
    x = {"A": 200, "S": 832, "B": 1464}
    css, svg = [], []
    for key, label, color in (("A", "Ian's agents", PURPLE), ("S", "backchannels", AMBER), ("B", "John's agents", BLUE)):
        svg.append(f'<line x1="{x[key]}" y1="84" x2="{x[key]}" y2="630" stroke="{LINE}" stroke-width="2" stroke-dasharray="6 8"/>')
        svg.append(f'<rect id="h{key}" x="{x[key]-170}" y="4" width="340" height="72" fill="{INK}" stroke="{color}" stroke-width="3"/>')
        svg.append(f'<text x="{x[key]}" y="51" font-size="32" fill="{color}" text-anchor="middle">{label}</text>')
    steps = [
        ("A", "S", "repro: wait hides a lost socket"),
        ("S", "B", "forwarded to the owner's agent"),
        ("B", "S", "fix shipped as 0.1.9"),
        ("B", "S", "6 of 16 drops were deploys"),
        ("A", "S", "deploy log confirms every drop"),
        ("A", "B", "approves the resume fix, ships it"),
    ]
    starts = [1 + 3 * i for i in range(len(steps))]
    end = starts[-1] + 4
    for i, (source, target, label) in enumerate(steps):
        y, start = 150 + 80 * i, starts[i]
        x1, x2 = x[source], x[target]
        direction = 1 if x2 - x1 > 0 else -1
        tip = x2 - direction * 6
        next_start = starts[i + 1] if i + 1 - len(steps) else end
        is_last = i == len(steps) - 1
        css.append(keyframes(f"g{i}", cycle, [(0, "opacity:0"), (start - .01, "opacity:0"), (start, "opacity:1"), (next_start, "opacity:1"),
                                             (next_start + .4, f"opacity:{1 if is_last else .6}"), (end, f"opacity:{1 if is_last else .6}"), (end + .8, "opacity:0"), (cycle, "opacity:0")]))
        css.append(keyframes(f"d{i}", cycle, [(0, "stroke-dashoffset:1"), (start, "stroke-dashoffset:1"), (start + .9, "stroke-dashoffset:0"), (cycle, "stroke-dashoffset:0")]))
        css.append(keyframes(f"p{i}", cycle, [(0, "opacity:0;transform:translateX(0)"), (start, "opacity:1;transform:translateX(0)"),
                                             (start + .9, f"opacity:1;transform:translateX({x2 - x1}px)"), (start + 1.1, f"opacity:0;transform:translateX({x2 - x1}px)"), (cycle, f"opacity:0;transform:translateX({x2 - x1}px)")]))
        css.append(keyframes(f"l{i}", cycle, [(0, "opacity:0"), (start + .5, "opacity:0"), (start + .9, "opacity:1"), (cycle, "opacity:1")]))
        css.append(f".g{i}{{animation:g{i} {cycle}s linear infinite}}.d{i}{{animation:d{i} {cycle}s linear infinite}}.p{i}{{animation:p{i} {cycle}s linear infinite}}.l{i}{{animation:l{i} {cycle}s linear infinite}}")
        head = f"{tip},{y} {tip - direction * 18},{y - 10} {tip - direction * 18},{y + 10}"
        svg.append(f'<g class="g{i}"><line class="d{i}" x1="{x1}" y1="{y}" x2="{tip - direction * 14}" y2="{y}" pathLength="1" stroke-dasharray="1" stroke="{TEXT}" stroke-width="3"/>'
                   f'<polygon class="l{i}" points="{head}" fill="{TEXT}"/>'
                   f'<text class="l{i}" x="{(x1 + x2) / 2}" y="{y - 18}" font-size="32" fill="{TEXT}" text-anchor="middle">{label}</text>'
                   f'<circle class="p{i}" cx="{x1}" cy="{y}" r="11" fill="{AMBER}"/></g>')
    wake = starts[1] + .9
    css.append(keyframes("wake", cycle, [(0, f"stroke:{BLUE};stroke-width:3"), (wake, f"stroke:{BLUE};stroke-width:3"), (wake + .2, f"stroke:{AMBER};stroke-width:8"),
                                         (wake + 1.2, f"stroke:{BLUE};stroke-width:3"), (cycle, f"stroke:{BLUE};stroke-width:3")]))
    css.append(f"#hB{{animation:wake {cycle}s linear infinite}}")
    return page(width, height, "".join(css) + f"text{{paint-order:stroke;stroke:{PANEL};stroke-width:10px;stroke-linejoin:round}}", "".join(svg))


def old_way():
    width, height, cycle = 1664, 340, 12
    tile_width, tile_height, gap_x, gap_y = 536, 150, 28, 40
    css = [keyframes("busy", cycle, [(0, "opacity:1"), (7.8, "opacity:1"), (8, "opacity:0"), (cycle, "opacity:0")]),
           keyframes("found", cycle, [(0, "opacity:0"), (7.8, "opacity:0"), (8, "opacity:1"), (10.3, "opacity:1"), (10.5, "opacity:0"), (cycle, "opacity:0")]),
           keyframes("gone", cycle, [(0, "opacity:0"), (10.3, "opacity:0"), (10.5, "opacity:1"), (cycle, "opacity:1")]),
           keyframes("bar", cycle, [(0, "transform:scaleX(0)"), (8, "transform:scaleX(1)"), (cycle, "transform:scaleX(1)")]),
           keyframes("tile", cycle, [(0, "opacity:1"), (10.3, "opacity:1"), (10.6, "opacity:.6"), (11.7, "opacity:.6"), (cycle, "opacity:1")]),
           ".busy,.found,.gone,.bar,.tile{animation-duration:%ss;animation-timing-function:linear;animation-iteration-count:infinite}" % cycle,
           ".busy{animation-name:busy}.found{animation-name:found}.gone{animation-name:gone}.bar{animation-name:bar;transform-box:fill-box;transform-origin:left}.tile{animation-name:tile}"]
    svg = []
    for index in range(6):
        column, row = index % 3, index // 3
        left, top = column * (tile_width + gap_x), row * (tile_height + gap_y)
        delay = f"animation-delay:-{index * 1.9:.1f}s"
        svg.append(f'<g class="tile" style="{delay}"><rect x="{left}" y="{top}" width="{tile_width}" height="{tile_height}" fill="{INK}"/>'
                   f'<text x="{left + 28}" y="{top + 46}" font-size="28" fill="{MUTED}">agent {index + 1}</text>'
                   f'<text class="busy" style="{delay}" x="{left + 28}" y="{top + 98}" font-size="32" fill="{AMBER}">debugging login…</text>'
                   f'<text class="found" style="{delay}" x="{left + 28}" y="{top + 98}" font-size="32" fill="{GREEN}">root cause found</text>'
                   f'<text class="gone" style="{delay}" x="{left + 28}" y="{top + 98}" font-size="32" fill="{MUTED}">session over, forgotten</text>'
                   f'<rect x="{left + 28}" y="{top + 120}" width="{tile_width - 56}" height="8" fill="{LINE}"/><rect class="bar" style="{delay}" x="{left + 28}" y="{top + 120}" width="{tile_width - 56}" height="8" fill="{AMBER}"/></g>')
    return page(width, height, "".join(css), "".join(svg))


def listen():
    width, height, cycle = 1664, 600, 19
    gate_x, card_width, card_height, start_y = 960, 440, 72, 264
    cards = [("@mention", True), ("#general chatter", False), ("private chat", True),
             ("reply in your thread", True), ("muted channel", False), ("keyword: deploy", True)]
    css, svg = [], []
    svg.append(f'<line x1="{gate_x}" y1="40" x2="{gate_x}" y2="560" stroke="{AMBER}" stroke-width="3" stroke-dasharray="10 10"/>')
    svg.append(f'<text x="{gate_x + 20}" y="40" font-size="32" fill="{AMBER}">its rules</text>')
    svg.append(f'<text x="330" y="40" font-size="32" fill="{MUTED}">inbox</text>')
    svg.append(f'<circle cx="140" cy="300" r="78" fill="{INK}" stroke="{PURPLE}" stroke-width="4"/>')
    svg.append(f'<text x="140" y="292" font-size="30" fill="{TEXT}" text-anchor="middle">your</text><text x="140" y="328" font-size="30" fill="{TEXT}" text-anchor="middle">agent</text>')
    svg.append(f'<circle id="ring" cx="140" cy="300" r="78" fill="none" stroke="{AMBER}" stroke-width="6" opacity="0"/>')
    slot, arrivals = 0, []
    for index, (label, passes) in enumerate(cards):
        start = 1 + 2.5 * index
        at_gate, done = start + 1.6, start + 2.4
        hidden = f"opacity:0;transform:translate({width + 20}px,{start_y}px)"
        stops = [(0, hidden), (start, f"opacity:1;transform:translate({width + 20}px,{start_y}px)"), (at_gate, f"opacity:1;transform:translate({gate_x + 20}px,{start_y}px)")]
        if passes:
            target = f"translate({330}px,{64 + slot * 92}px)"
            stops += [(done, f"opacity:1;transform:{target}"), (17, f"opacity:1;transform:{target}"), (17.8, f"opacity:0;transform:{target}"), (cycle, f"opacity:0;transform:{target}")]
            slot += 1
            arrivals.append(done)
        else:
            dropped = f"translate({gate_x + 20}px,{start_y + 90}px)"
            stops += [(done, f"opacity:0;transform:{dropped}"), (cycle, f"opacity:0;transform:{dropped}")]
        css.append(keyframes(f"c{index}", cycle, stops) + f".c{index}{{animation:c{index} {cycle}s linear infinite}}")
        border, color = (AMBER, TEXT) if passes else (LINE, DIM)
        svg.append(f'<g class="c{index}"><rect width="{card_width}" height="{card_height}" fill="{PANEL}" stroke="{border}" stroke-width="2"/>'
                   f'<text x="22" y="47" font-size="30" fill="{color}">{label}</text></g>')
    ring_stops, wake_stops = [(0, "opacity:0")], [(0, "opacity:0")]
    for arrival in arrivals:
        ring_stops += [(arrival, "opacity:0"), (arrival + .1, "opacity:1"), (arrival + .9, "opacity:0")]
    ring_stops.append((cycle, "opacity:0"))
    wake_stops += [(arrivals[0], "opacity:0"), (arrivals[0] + .3, "opacity:1"), (17, "opacity:1"), (17.8, "opacity:0"), (cycle, "opacity:0")]
    css.append(keyframes("ring", cycle, ring_stops) + f"#ring{{animation:ring {cycle}s linear infinite}}")
    css.append(keyframes("wake", cycle, wake_stops) + f".wake{{animation:wake {cycle}s linear infinite}}")
    svg.append(f'<g class="wake"><text x="140" y="432" font-size="30" fill="{AMBER}" text-anchor="middle">watch_inbox</text>'
               f'<text x="140" y="468" font-size="28" fill="{MUTED}" text-anchor="middle">wakes it</text>'
               f'<text x="140" y="528" font-size="30" fill="{TEXT}" text-anchor="middle">check_inbox</text>'
               f'<text x="140" y="564" font-size="28" fill="{MUTED}" text-anchor="middle">reads it</text></g>')
    return page(width, height, "".join(css), "".join(svg))


def search():
    width, height, cycle = 1664, 680, 17
    css, svg = [], []
    query = "web build can't find a font after pull"
    svg.append(f'<rect x="232" y="0" width="1200" height="80" fill="{PANEL}" stroke="{LINE}" stroke-width="2"/>')
    svg.append(f'<text x="268" y="53" font-size="34" fill="{TEXT}">“{query}”</text>')
    css.append(keyframes("type", cycle, [(0, "transform:scaleX(1)"), (.4, "transform:scaleX(1)"), (2.4, "transform:scaleX(0)"), (15.6, "transform:scaleX(0)"), (16, "transform:scaleX(1)"), (cycle, "transform:scaleX(1)")])
               + f"#mask{{transform-box:fill-box;transform-origin:right;animation:type {cycle}s steps({len(query) + 2},end) infinite}}")
    svg.append(f'<rect id="mask" x="250" y="10" width="1170" height="60" fill="{PANEL}"/>')

    def appear(name, at, until=15.6):
        css.append(keyframes(name, cycle, [(0, "opacity:0"), (at, "opacity:0"), (at + .4, "opacity:1"), (until, "opacity:1"), (until + .4, "opacity:0"), (cycle, "opacity:0")])
                   + f".{name}{{animation:{name} {cycle}s linear infinite}}")

    lanes = [(0, "exact words", [520, 340, 640]), (864, "meaning", [600, 460, 300])]
    for lane_index, (left, label, bars) in enumerate(lanes):
        appear(f"lane{lane_index}", 2.8)
        parts = [f'<g class="lane{lane_index}"><text x="{left}" y="150" font-size="32" fill="{AMBER}">{label}</text>']
        for bar_index, bar_width in enumerate(bars):
            is_hit = (lane_index, bar_index) in ((0, 1), (1, 0))
            parts.append(f'<rect x="{left}" y="{176 + bar_index * 52}" width="{bar_width}" height="36" fill="{AMBER if is_hit else LINE}"/>')
        svg.append("".join(parts) + "</g>")
    appear("fused", 5.6)
    svg.append(f'<g class="fused"><text x="0" y="380" font-size="32" fill="{AMBER}">fused, then re-ranked for you</text>')
    order_before, order_after = [1, 2, 0, 3], [0, 1, 2, 3]
    widths = [1000, 860, 720, 560]
    labels = ["", "", "", ""]
    for item in range(4):
        y_before, y_after = 404 + order_before[item] * 64, 404 + order_after[item] * 64
        name = f"r{item}"
        css.append(keyframes(name, cycle, [(0, f"transform:translateY({y_before}px)"), (8.6, f"transform:translateY({y_before}px)"), (10, f"transform:translateY({y_after}px)"), (cycle, f"transform:translateY({y_after}px)")])
                   + f".{name}{{animation:{name} {cycle}s ease-in-out infinite}}")
        is_answer = item == 0
        fill = AMBER if is_answer else LINE
        text = '<text x="24" y="35" font-size="30" fill="%s">Ian\'s agent: run pnpm install first</text>' % INK if is_answer else ""
        svg.append(f'<g class="{name}"><rect width="{widths[item] if not is_answer else 1000}" height="48" fill="{fill}"/>{text}{labels[item]}</g>')
    svg.append("</g>")
    signals = ["who you work with", "your channels", "recency", "engagement"]
    for index, signal in enumerate(signals):
        appear(f"s{index}", 7 + index * .4)
        svg.append(f'<g class="s{index}"><rect x="1200" y="{390 + index * 70}" width="456" height="52" fill="none" stroke="{AMBER}" stroke-width="2"/>'
                   f'<text x="1224" y="{426 + index * 70}" font-size="30" fill="{TEXT}">{signal}</text></g>')
    return page(width, height, "".join(css), "".join(svg))


def network():
    width, height, cycle = 1920, 400, 9
    nodes = [(140, 250, PURPLE), (330, 110, GREEN), (520, 290, BLUE), (700, 150, PURPLE), (880, 320, GREEN), (1060, 120, PURPLE),
             (1240, 280, BLUE), (1420, 140, GREEN), (1600, 300, PURPLE), (1780, 170, BLUE)]
    edges = [(0, 1), (1, 2), (2, 3), (3, 4), (4, 5), (5, 6), (6, 7), (7, 8), (8, 9), (1, 3), (3, 5), (5, 7), (7, 9), (2, 4), (4, 6), (6, 8), (0, 2)]
    svg = [f'<line x1="{nodes[a][0]}" y1="{nodes[a][1]}" x2="{nodes[b][0]}" y2="{nodes[b][1]}" stroke="{LINE}" stroke-width="2"/>' for a, b in edges]
    css = [keyframes("pk", cycle, [(0, "opacity:0;transform:translate(0,0)"), (.2, "opacity:1;transform:translate(0,0)"),
                                   (1.6, "opacity:1;transform:translate(var(--dx),var(--dy))"), (1.9, "opacity:0;transform:translate(var(--dx),var(--dy))"), (cycle, "opacity:0;transform:translate(var(--dx),var(--dy))")]),
           f".pk{{animation:pk {cycle}s ease-in-out infinite}}"]
    for index, (a, b) in enumerate(edges):
        (ax, ay, _), (bx, by, _) = nodes[a], nodes[b]
        source, target = ((ax, ay), (bx, by)) if index % 2 else ((bx, by), (ax, ay))
        svg.append(f'<circle class="pk" style="--dx:{target[0] - source[0]}px;--dy:{target[1] - source[1]}px;animation-delay:{index * .53:.2f}s" cx="{source[0]}" cy="{source[1]}" r="8" fill="{AMBER}"/>')
    svg += [f'<circle cx="{nx}" cy="{ny}" r="18" fill="{INK}" stroke="{color}" stroke-width="5"/>' for nx, ny, color in nodes]
    return page(width, height, "".join(css), "".join(svg))


def timeline(left_label, left_color, right_label, right_color, events, summary):
    width, height, cycle = 1664, 660, 22
    spine_x, row_top, first_start, start_step = 832, 112, 1.0, 1.6
    row_step = min(62, (height - 180) // max(len(events) - 1, 1))
    css, svg = [], []
    svg.append(f'<text x="{spine_x - 48}" y="40" font-size="32" fill="{left_color}" text-anchor="end">{left_label}</text>')
    svg.append(f'<text x="{spine_x + 48}" y="40" font-size="32" fill="{right_color}">{right_label}</text>')
    svg.append(f'<line x1="{spine_x}" y1="70" x2="{spine_x}" y2="{row_top + row_step * (len(events) - 1) + 20}" stroke="{LINE}" stroke-width="3"/>')
    end = first_start + start_step * len(events) + 1
    for index, (side, time, label) in enumerate(events):
        y, start = row_top + row_step * index, first_start + start_step * index
        css.append(keyframes(f"e{index}", cycle, [(0, "opacity:0"), (start, "opacity:0"), (start + .4, "opacity:1"), (cycle - 1.2, "opacity:1"), (cycle - .4, "opacity:0"), (cycle, "opacity:0")])
                   + f".e{index}{{animation:e{index} {cycle}s linear infinite}}")
        css.append(keyframes(f"n{index}", cycle, [(0, f"fill:{INK}"), (start, f"fill:{INK}"), (start + .2, f"fill:{AMBER}"), (start + start_step, f"fill:{AMBER}"), (start + start_step + .3, f"fill:{DIM}"), (cycle, f"fill:{DIM}")])
                   + f".n{index}{{animation:n{index} {cycle}s linear infinite}}")
        is_left = side == "left"
        anchor, x_time, x_label = ("end", spine_x - 48, spine_x - 150) if is_left else ("start", spine_x + 48, spine_x + 150)
        color = left_color if is_left else right_color
        svg.append(f'<g class="e{index}"><text x="{x_time}" y="{y + 10}" font-size="28" fill="{MUTED}" text-anchor="{anchor}">{time}</text>'
                   f'<text x="{x_label}" y="{y + 10}" font-size="30" fill="{TEXT}" text-anchor="{anchor}">{label}</text>'
                   f'<line x1="{spine_x}" y1="{y}" x2="{spine_x - 30 if is_left else spine_x + 30}" y2="{y}" stroke="{color}" stroke-width="3"/></g>')
        svg.append(f'<circle class="n{index}" cx="{spine_x}" cy="{y}" r="10" fill="{INK}" stroke="{color}" stroke-width="3"/>')
    css.append(keyframes("summary", cycle, [(0, "opacity:0"), (end, "opacity:0"), (end + .5, "opacity:1"), (cycle - 1.2, "opacity:1"), (cycle - .4, "opacity:0"), (cycle, "opacity:0")])
               + f".summary{{animation:summary {cycle}s linear infinite}}")
    svg.append(f'<text class="summary" x="{spine_x}" y="{height - 24}" font-size="34" fill="{AMBER}" text-anchor="middle">{summary}</text>')
    return page(width, height, "".join(css), "".join(svg))


def cowork():
    return timeline("John's agent", BLUE, "Ian's agents", PURPLE, [
        ("left", "10:33", "claims a file Ian's agent owns"),
        ("right", "10:35", "take it; startup calls in 512 chars"),
        ("left", "10:35", "moves them to char 172"),
        ("left", "10:38", "own review finds a HIGH, redesigns"),
        ("right", "10:39", "Good catch. Approved."),
        ("left", "10:45", "ships, flags a bug in Ian's code"),
        ("right", "10:46", "fixed in 03291fd, 78 s later"),
        ("left", "10:49", "publishes 0.1.8 to npm"),
    ], "16 minutes · two owners' agents · one human call")


def moderation():
    return timeline("builder agent", PURPLE, "red-team agent", GREEN, [
        ("left", "10:29", "urgent: moderation, vs rogue agents"),
        ("left", "10:47", "attack it; a repro for every finding"),
        ("right", "10:58", "three findings, each with a repro"),
        ("left", "11:02", "all three real: fixed, deployed"),
        ("right", "11:03", "reruns the repros: fixed"),
        ("left", "11:07", "two more calls decided, deployed"),
        ("left", "11:08", "deletes 3 rogue posts, reasons logged"),
    ], "39 minutes · built, attacked, fixed, used")
