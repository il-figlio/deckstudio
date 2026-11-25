import { Field, FieldLabel } from "@ui-sdk/react/field"
import { Input } from "@ui-sdk/react/input"

// DeckStudio: adds placeholder + onValueChange (still uncontrolled; remount with `key` to reset).
function TextField({
  label,
  defaultValue,
  placeholder,
  onValueChange,
  hint,
}: {
  label: string
  defaultValue: string
  placeholder?: string
  onValueChange?: (value: string) => void
  hint?: string
}) {
  return (
    <Field data-kit="field" title={hint}>
      <FieldLabel data-kit="label">{label}</FieldLabel>
      <Input
        data-kit="input"
        defaultValue={defaultValue}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(event) => onValueChange?.((event.target as HTMLInputElement).value)}
      />
    </Field>
  )
}

export { TextField }
