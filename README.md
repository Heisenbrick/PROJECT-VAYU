# Project VAYU - VTOL Cargo Drone

![Project VAYU](https://images.unsplash.com/photo-1473968512647-3e447244af8f?auto=format&fit=crop&q=80&w=1200)

## Overview
**Project VAYU** is an autonomous Heavy-Lift VTOL (Vertical Take-Off and Landing) Cargo Drone system. 
Designed by Team VAYU at S-VYASA campus, this project bridges the gap in modern drone delivery by providing a solution capable of lifting up to 80 kg payload with a compact 3x3m footprint. 

Unlike conventional multirotor drones, VAYU utilizes four ducted, counter-rotating tilt-fans mounted on a fixed wing spar. This allows it to takeoff vertically and then transition to horizontal flight for high efficiency.

## Features
- **Autonomous Flight:** Built-in AI pilot that handles flight operations, including the complex tilt-transition, from a single destination input.
- **Flight Dynamics Simulator:** A robust simulator that models flight phases, gyroscopic torque, and telemetry.
- **Mission Dashboard:** A control interface to monitor flight paths, telemetry, and system status.
- **Aerodynamic Design:** Ducted shrouding to cut tip-vortex noise and improve thrust efficiency.

## Repository Structure
- `index.html`: The main landing page of the project.
- `/Dashboard`: The command center UI for monitoring the drone.
- `/Simulator`: Flight dynamics and 3D visualization simulator.
- `.github/workflows`: Contains the GitHub Actions CI/CD configuration to automatically deploy this site to GitHub Pages.

## Live Demo
This project is configured to be deployed automatically to GitHub Pages via GitHub Actions.
Check the repository settings or the environments tab to find the live URL.

## Local Setup
This project consists of static HTML, CSS, and JavaScript. 
To run it locally:
1. Clone the repository.
2. Open `index.html` in your web browser. 
*(Alternatively, you can run a local development server like Live Server in VS Code for a better experience).*

## Roadmap
1. **Short-Term (Build Week):** Flight-dynamics simulation, structural CAD design, and early-stage AI Pilot model.
2. **Long-Term:** Transition from a digital proof-of-concept to a physical working prototype capable of commercial delivery routes.
