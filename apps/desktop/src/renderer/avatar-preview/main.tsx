import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AvatarPreview } from './AvatarPreview'
import '../src/assets/main.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AvatarPreview />
  </StrictMode>
)
