import os
import sys

# Pipeline scripts are top-level modules (``import score``), not a package.
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
