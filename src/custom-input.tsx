/**
 * Prompt local: texto + cursor en el mismo paint.
 * No sube cada tecla al App (eso titilaba el TUI entero y la barrita se atrasaba).
 */
import { Text, useInput } from "ink";
import { useEffect, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import { mouseKind, peelInput } from "./buffer.js";

type CustomInputProps = {
  draftRef: MutableRefObject<string>;
  resetTick: number;
  onSubmit: (value: string) => void;
  placeholder?: string;
  mask?: string;
  offsetX: number;
};

type Paint = { text: string; cursor: number };

export function CustomInput(props: CustomInputProps): ReactNode {
  const { draftRef, resetTick, onSubmit, placeholder, mask, offsetX } = props;
  const textRef = useRef("");
  const cursorRef = useRef(0);
  const [paint, setPaint] = useState<Paint>({ text: "", cursor: 0 });

  useEffect(() => {
    textRef.current = "";
    cursorRef.current = 0;
    draftRef.current = "";
    setPaint({ text: "", cursor: 0 });
  }, [resetTick, draftRef]);

  const show = (): void => {
    draftRef.current = textRef.current;
    setPaint({ text: textRef.current, cursor: cursorRef.current });
  };

  useInput((input, key) => {
    const peeled = peelInput(input);
    for (const ev of peeled.events) {
      if (mouseKind(ev) !== "down") continue;
      cursorRef.current = Math.max(0, Math.min(textRef.current.length, ev.x - 1 - offsetX));
      show();
    }
    const raw = peeled.text;
    if (peeled.events.length && !raw && !key.return && !key.backspace && !key.delete) return;

    if (key.return) {
      onSubmit(textRef.current);
      return;
    }
    if (key.leftArrow) {
      if (cursorRef.current > 0) {
        cursorRef.current -= 1;
        show();
      }
      return;
    }
    if (key.rightArrow) {
      if (cursorRef.current < textRef.current.length) {
        cursorRef.current += 1;
        show();
      }
      return;
    }
    if (key.home) {
      cursorRef.current = 0;
      show();
      return;
    }
    if (key.end) {
      cursorRef.current = textRef.current.length;
      show();
      return;
    }
    if (key.backspace || key.delete) {
      if (cursorRef.current > 0) {
        const t = textRef.current;
        const c = cursorRef.current;
        textRef.current = t.slice(0, c - 1) + t.slice(c);
        cursorRef.current = c - 1;
        show();
      }
      return;
    }
    if (key.ctrl || key.meta || key.escape || key.tab) return;
    const clean = raw.replace(/\t/g, "").replace(/\x7f/g, "").replace(/\x08/g, "");
    if (!clean) return;
    const t = textRef.current;
    const c = cursorRef.current;
    textRef.current = t.slice(0, c) + clean + t.slice(c);
    cursorRef.current = c + clean.length;
    show();
  });

  const { text, cursor } = paint;
  const display = mask ? mask.repeat(text.length) : text;
  const pos = Math.max(0, Math.min(display.length, cursor));

  if (!display && placeholder) {
    const ch = placeholder[pos] ?? " ";
    return (
      <Text>
        {pos > 0 ? <Text dimColor>{placeholder.slice(0, pos)}</Text> : null}
        <Text inverse>{ch}</Text>
        {pos < placeholder.length ? <Text dimColor>{placeholder.slice(pos + 1)}</Text> : null}
      </Text>
    );
  }

  if (!display) return <Text inverse> </Text>;

  return (
    <Text>
      {display.slice(0, pos) || null}
      <Text inverse>{display[pos] ?? " "}</Text>
      {display.slice(pos + 1) || null}
    </Text>
  );
}
