import * as React from "react"

export type WidgetChoice = {
  id: string
  label: string
  image?: string
  description?: string
  disabled?: boolean
}

export type ChoiceGroupProps = {
  label: string
  options: WidgetChoice[]
  value: string[]
  onChange: (value: string[]) => void
  multiple?: boolean
  disabled?: boolean
}

/** Controlled values survive filtering and pagination by the containing widget. */
export function WidgetChoiceGroup({
  label,
  options,
  value,
  onChange,
  multiple = false,
  disabled = false,
}: ChoiceGroupProps) {
  return (
    <div role="group" aria-label={label} className="widget-choice-group">
      {options.map((option) => {
        const selected = value.includes(option.id)
        const image =
          option.image &&
          (/^https:\/\//.test(option.image) ||
            /^\/widget-template-assets\/[a-z0-9-]+\.webp$/.test(option.image))
            ? option.image
            : undefined
        return (
          <button
            key={option.id}
            type="button"
            className="widget-choice"
            aria-label={option.label}
            aria-pressed={selected}
            disabled={disabled || option.disabled}
            onClick={() =>
              onChange(
                multiple
                  ? selected
                    ? value.filter((id) => id !== option.id)
                    : [...value, option.id]
                  : [option.id]
              )
            }
          >
            {image ? (
              <img src={image} alt="" referrerPolicy="no-referrer" />
            ) : null}
            <span className="widget-choice-label">{option.label}</span>
            {option.description ? (
              <span className="widget-choice-description">
                {option.description}
              </span>
            ) : null}
            {selected ? (
              <span aria-hidden className="widget-choice-check">
                ✓
              </span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}

export type DatePickerProps = {
  label: string
  value: string
  onChange: (value: string) => void
  min?: string
  max?: string
  required?: boolean
  disabled?: boolean
  locale?: string
}

/** Native calendar UI; exchange date-only ISO values without timezone conversion. */
export function WidgetDatePicker({
  label,
  value,
  onChange,
  ...props
}: DatePickerProps) {
  const { locale, ...inputProps } = props
  return (
    <label className="widget-date-field">
      <span>{label}</span>
      <input
        {...inputProps}
        type="date"
        lang={locale}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  )
}
