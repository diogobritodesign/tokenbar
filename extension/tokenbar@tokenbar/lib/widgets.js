// Peças de interface reutilizadas pela barra e pelo painel.
import Cairo from 'gi://cairo';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

// Largura útil de um cartão, em px de CSS.
export const CONTENT_WIDTH = 356;
// Espessura do anel da barra superior, como fração do diâmetro.
const RING_LINE_RATIO = 0.18;
const RING_TRACK_ALPHA = 0.3;
// Quanto o botão do interruptor anda entre desligado e ligado, em px de CSS.
const SWITCH_TRAVEL = 14;
const LEVELS = ['ok', 'warn', 'crit', 'off'];

// Abre um endereço da web no navegador padrão.
export function openUri(uri) {
    try {
        Gio.AppInfo.launch_default_for_uri(uri, null);
    } catch (error) {
        console.error(`tokenbar: could not open ${uri}: ${error.message}`);
    }
}

export function openFolder(path) {
    try {
        const editor = GLib.find_program_in_path('code');
        if (editor)
            Gio.Subprocess.new([editor, path], Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
        else
            Gio.AppInfo.launch_default_for_uri(GLib.filename_to_uri(path, null), null);
    } catch (error) {
        console.error(`tokenbar: could not open the folder: ${error.message}`);
    }
}

export function setLevel(actor, level) {
    for (const name of LEVELS)
        actor.remove_style_class_name(`tokenbar-${name}`);
    actor.add_style_class_name(`tokenbar-${level}`);
}

export function makeDot(level) {
    const dot = new St.Widget({
        style_class: 'tokenbar-dot',
        y_align: Clutter.ActorAlign.CENTER,
    });
    setLevel(dot, level);
    return dot;
}

// Anel de progresso da barra superior: o arco cresce no sentido horário a
// partir do topo, na cor do nível (lida do CSS pela propriedade `color`).
export function makeRing(level, pct) {
    const ring = new St.DrawingArea({
        style_class: 'tokenbar-ring',
        y_align: Clutter.ActorAlign.CENTER,
    });
    setLevel(ring, level);
    ring.connect('repaint', area => {
        const cr = area.get_context();
        const [width, height] = area.get_surface_size();
        const line = Math.max(2, Math.round(Math.min(width, height) * RING_LINE_RATIO));
        const radius = (Math.min(width, height) - line) / 2;
        cr.setLineWidth(line);

        // Trilho na cor do nível, bem apagado: um anel vazio continua
        // dizendo se a conta está tranquila ou no limite.
        const color = area.get_theme_node().get_foreground_color();
        const rgb = [color.red / 255, color.green / 255, color.blue / 255];
        cr.setSourceRGBA(...rgb, RING_TRACK_ALPHA);
        cr.arc(width / 2, height / 2, radius, 0, 2 * Math.PI);
        cr.stroke();

        if (pct !== null && pct > 0) {
            const start = -Math.PI / 2;
            cr.setSourceRGBA(...rgb, color.alpha / 255);
            cr.setLineCap(Cairo.LineCap.ROUND);
            cr.arc(width / 2, height / 2, radius, start, start + 2 * Math.PI * Math.min(pct, 100) / 100);
            cr.stroke();
        }
        cr.$dispose();
    });
    return ring;
}

// Barras do uso diário; os últimos `highlight` dias (o período escolhido)
// ficam em destaque e o resto apagado.
export function makeChart(series, highlight) {
    const chart = new St.DrawingArea({
        style_class: 'tokenbar-chart',
        style: `width: ${CONTENT_WIDTH}px;`,
    });
    const useCost = series.some(day => day.costUsd > 0);
    const values = series.map(day => (useCost ? day.costUsd : day.tokens) || 0);
    const peak = Math.max(...values, 1e-9);
    chart.connect('repaint', area => {
        const cr = area.get_context();
        const [width, height] = area.get_surface_size();
        const gap = Math.max(1, Math.round(width / 180));
        const barWidth = (width - gap * (values.length - 1)) / values.length;
        values.forEach((value, index) => {
            const barHeight = value > 0 ? Math.max(2, value / peak * height) : 1;
            if (index >= values.length - highlight)
                cr.setSourceRGBA(0.663, 0.486, 0.973, 1);
            else
                cr.setSourceRGBA(1, 1, 1, 0.14);
            cr.rectangle(index * (barWidth + gap), height - barHeight, barWidth, barHeight);
            cr.fill();
        });
        cr.$dispose();
    });
    return chart;
}

export function makeSwitch(active, onChange) {
    // Trilho de posição fixa: o botão desliza mudando só o x.
    const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
    const knob = new St.Widget({style_class: 'tokenbar-switch-knob'});
    const track = new St.Widget({style_class: 'tokenbar-switch-track'});
    track.add_child(knob);
    const button = new St.Button({
        style_class: 'tokenbar-switch',
        toggle_mode: true,
        checked: active,
        can_focus: true,
        child: track,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
    });
    const sync = () => {
        knob.x = button.checked ? SWITCH_TRAVEL * scale : 0;
    };
    sync();
    button.connect('clicked', () => {
        sync();
        onChange(button.checked);
    });
    return button;
}

export function makeChoice(options, current, onPick) {
    const box = new St.BoxLayout({style_class: 'tokenbar-segmented tokenbar-choice'});
    const buttons = [];
    const select = chosen => {
        for (const [value, button] of buttons) {
            if (value === chosen)
                button.add_style_class_name('tokenbar-button-primary');
            else
                button.remove_style_class_name('tokenbar-button-primary');
        }
    };
    for (const [value, text] of options) {
        const button = new St.Button({
            style_class: 'tokenbar-button tokenbar-button-small',
            label: text,
            can_focus: true,
            x_expand: true,
        });
        button.connect('clicked', () => {
            select(value);
            onPick(value);
        });
        buttons.push([value, button]);
        box.add_child(button);
    }
    select(current);
    return box;
}

export function makeStepper(read, write, format) {
    const box = new St.BoxLayout({style_class: 'tokenbar-stepper'});
    const value = new St.Label({
        style_class: 'tokenbar-stepper-value',
        text: format(read()),
        y_align: Clutter.ActorAlign.CENTER,
    });
    const step = (text, direction) => {
        const button = new St.Button({style_class: 'tokenbar-step', label: text, can_focus: true});
        button.connect('clicked', () => {
            write(direction);
            value.text = format(read());
        });
        return button;
    };
    box.add_child(step('−', -1));
    box.add_child(value);
    box.add_child(step('+', 1));
    return box;
}

// Rótulo pequeno em cima de um controle que ocupa a largura toda.
export function labeled(text, control) {
    const box = new St.BoxLayout({
        style_class: 'tokenbar-labeled',
        orientation: Clutter.Orientation.VERTICAL,
    });
    box.add_child(new St.Label({style_class: 'tokenbar-muted tokenbar-small', text}));
    box.add_child(control);
    return box;
}

export function settingRow(text, control) {
    const row = new St.BoxLayout({style_class: 'tokenbar-set-row'});
    row.add_child(new St.Label({
        text,
        x_expand: true,
        y_align: Clutter.ActorAlign.CENTER,
    }));
    row.add_child(control);
    return row;
}
