"""Utilities used by the fixture service."""


def helper(name):
    """Formats a greeting."""
    return "hello %s" % name


class Greeter:
    def __init__(self, name):
        self.name = name

    def greet(self):
        return helper(self.uniquely_named_method())

    def uniquely_named_method(self):
        return self.name
