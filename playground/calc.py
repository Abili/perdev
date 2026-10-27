# A tiny sandbox project for trying PerDev. Ask the agent things like:
#   "add a divide function that raises on divide-by-zero, and test it"
#   "run the tests and fix anything that fails"


def add(a, b):
    return a + b


def subtract(a, b):
    return a - b


def average(numbers):
    return sum(numbers) / len(numbers)
