import { createRoot } from 'react-dom/client'
import App from './App'
import {StudioMotion} from './motion'
import './style.css'
import './studio.css'
import './workflow.css'
import './motion.css'

createRoot(document.getElementById('root')!).render(<StudioMotion><App /></StudioMotion>)
