import { haptic } from "@/lib/haptics"
import { Field, FieldLabel } from "@ui-sdk/react/field"
import { NumberInput, NumberInputControl, NumberInputDecrement, NumberInputGroup, NumberInputIncrement } from "@ui-sdk/react/number-input"
import { Icon } from "@/components/ui/icon"

// DeckStudio: adds min/max/step, an empty state, and onValueChange.
function Stepper({
  label,
  defaultValue,
  min = 0,
  max = 999,
  step = 1,
  onValueChange,
  onValueCommit,
}: {
  label: string
  defaultValue: number | null
  min?: number
  max?: number
  step?: number
  onValueChange?: (value: number | null) => void
  /** DeckStudio: fires on blur / Enter / a step button, not on every keystroke. */
  onValueCommit?: (value: number | null) => void
}) {
  return (
    // A tick per step, pressed once or held to repeat.
    <NumberInput
      defaultValue={defaultValue}
      min={min}
      max={max}
      step={step}
      onValueChange={(value) => {
        haptic("selection")
        onValueChange?.(value)
      }}
      onValueCommit={(value) => onValueCommit?.(value)}
    >
      <Field data-kit="field">
        <FieldLabel data-kit="label">{label}</FieldLabel>
        <NumberInputGroup data-kit="stepper">
          <NumberInputDecrement data-kit="button" data-tone="secondary" aria-label="Decrease">
            <Icon name="minus" />
          </NumberInputDecrement>
          <NumberInputControl data-kit="stepper-input" aria-label={label} />
          <NumberInputIncrement data-kit="button" data-tone="secondary" aria-label="Increase">
            <Icon name="plus" />
          </NumberInputIncrement>
        </NumberInputGroup>
      </Field>
    </NumberInput>
  )
}

export { Stepper }
