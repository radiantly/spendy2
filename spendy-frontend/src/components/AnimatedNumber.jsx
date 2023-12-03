import { motion, animate, useMotionValue, useTransform } from "framer-motion";
import { useEffect } from "react";

const AnimatedNumber = ({ number, transform, ...props }) => {
  const count = useMotionValue(0);
  const rounded = useTransform(count, transform);

  useEffect(() => {
    const controls = animate(count, number);

    return controls.stop;
  }, [number]);

  return <motion.div {...props}>{rounded}</motion.div>;
};

export default AnimatedNumber;
