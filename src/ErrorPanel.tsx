import React from 'react'

export type ActiveErrors = { [source: string]: string }

type Props = {
  errors: ActiveErrors
}

// Fixed panel listing currently active errors. Renders nothing when there are none.
export default function ErrorPanel({ errors }: Props) {
  const entries = Object.entries(errors)
  if (entries.length === 0) return null
  return (
    <div className="error-panel" role="alert">
      {entries.map(([source, message]) => (
        <div key={source} className="error-panel-entry">
          <span className="error-panel-source">{source}</span>
          <span className="error-panel-message">{message}</span>
        </div>
      ))}
    </div>
  )
}
