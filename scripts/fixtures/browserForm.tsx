import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'

export function BrowserForm(): React.JSX.Element {
  const [name, setName] = useState('')
  const [accepted, setAccepted] = useState(false)
  const [choice, setChoice] = useState('first')
  const [submissions, setSubmissions] = useState<string[]>([])
  return (
    <main>
      <h1>Controlled browser form</h1>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          setSubmissions((items) => [...items, `${name}:${accepted}:${choice}`])
          setName('')
        }}
      >
        <label>
          Name
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label>
          Accept
          <input
            type="checkbox"
            checked={accepted}
            onChange={(event) => setAccepted(event.target.checked)}
          />
        </label>
        <label>
          Choice
          <select value={choice} onChange={(event) => setChoice(event.target.value)}>
            <option value="first">First</option>
            <option value="second">Second</option>
          </select>
        </label>
        <button type="submit">Save</button>
      </form>
      <div contentEditable suppressContentEditableWarning aria-label="Notes">
        Initial
      </div>
      <ol>
        {submissions.map((item, index) => (
          <li key={index}>{item}</li>
        ))}
      </ol>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<BrowserForm />)
