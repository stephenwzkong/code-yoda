from .util import Greeter, helper


def run():
    greeter = Greeter("world")
    return greeter.greet() + helper("direct")
