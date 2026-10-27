import unittest

from calc import add, average, subtract


class CalcTest(unittest.TestCase):
    def test_add(self):
        self.assertEqual(add(2, 3), 5)

    def test_subtract(self):
        self.assertEqual(subtract(5, 3), 2)

    def test_average_empty(self):
        # Bug for the agent to find: average([]) crashes with ZeroDivisionError.
        self.assertEqual(average([]), 0)


if __name__ == "__main__":
    unittest.main()
