from .util import Greeter, helper


def run():
    greeter = Greeter("world")
    return greeter.greet() + helper("direct")


# Module-level object built by a call — the structure of many declarative files.
default_greeter = Greeter("module-level")
_private_thing = Greeter("hidden")
PLAIN_CONSTANT = 42
