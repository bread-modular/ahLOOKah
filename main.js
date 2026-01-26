import p5 from 'p5';
import './style.css';

const sketch = (p) => {
  p.setup = () => {
    p.createCanvas(p.windowWidth, p.windowHeight);
  };

  p.draw = () => {
    p.background(0);

    // Draw something dynamic
    p.noStroke();
    p.fill(255, 100);
    p.circle(p.mouseX, p.mouseY, 50);

    p.fill(255);
    p.textSize(32);
    p.textAlign(p.CENTER, p.CENTER);
    p.text('p5.js + Vite', p.width / 2, p.height / 2);
  };

  p.windowResized = () => {
    p.resizeCanvas(p.windowWidth, p.windowHeight);
  };
};

new p5(sketch);
