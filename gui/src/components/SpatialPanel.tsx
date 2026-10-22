import type {ReactNode} from 'react'
import {motion, useIsPresent, type HTMLMotionProps} from 'motion/react'
import {springs, fade} from '../motion'

export function SpatialPanel({children, width, ...props}: Omit<HTMLMotionProps<'aside'>, 'children'> & {width: string; children: ReactNode}) {
  const present = useIsPresent()
  return <motion.aside {...props} inert={!present} initial={{width: 0, opacity: 0}}
    animate={{width, opacity: 1}} exit={{width: 0, opacity: 0}}
    transition={{...springs.spatial, opacity: fade}} style={{display: 'flex', ...props.style}}>
    <div className="spatial-panel-content" style={{width, minWidth: width}}>{children}</div>
  </motion.aside>
}
