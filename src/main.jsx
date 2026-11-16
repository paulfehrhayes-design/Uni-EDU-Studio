import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import HarryBotterTry from './components/HarryBotterTry.jsx'

const isHarryBotterPreview = new URLSearchParams(window.location.search).get('try') === 'harry-botter'
const RootApp = isHarryBotterPreview ? HarryBotterTry : App

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <RootApp />
  </StrictMode>,
)
