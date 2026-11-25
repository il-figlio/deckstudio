import { Field, FieldLabel } from "@ui-sdk/react/field"
import { Textarea as SdkTextarea } from "@ui-sdk/react/textarea"

// DeckStudio: adds defaultValue + onValueChange.
function Textarea({
  label,
  placeholder,
  defaultValue,
  onValueChange,
  invalid,
}: {
  label: string
  placeholder?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
  invalid?: boolean
}) {
  return (
    <Field data-kit="field" data-invalid={invalid || undefined}>
      <FieldLabel data-kit="label">{label}</FieldLabel>
      <SdkTextarea
        data-kit="input"
        data-multiline=""
        placeholder={placeholder}
        defaultValue={defaultValue}
        spellCheck={false}
        onChange={(event) => onValueChange?.((event.target as HTMLTextAreaElement).value)}
      />
    </Field>
  )
}

export { Textarea }
