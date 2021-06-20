import json
from apollo.models import LoggedInUser, Player, TargetWord
from apollo.helpers import *
from asgiref.sync import async_to_sync
from channels.generic.websocket import WebsocketConsumer


class Consumer(WebsocketConsumer):
    def connect(self):
        # Get player's username
        username = self.scope['user'].get_username()

        # Set player's logged in status in DB
        player = Player.objects.get(name=username)
        player.is_logged_in = True
        player.save()

        # Add user to a group
        group_name = "online"
        async_to_sync(self.channel_layer.group_add)(
            group_name,
            self.channel_name
        )

        # Get number of online users
        active_users = len(Player.objects.filter(is_logged_in=True))

        # Get payload to send back
        target_word = get_target_word()
        starter_words = get_starter_words()
        previous_target_word, completed_from, completed_in = get_previous_target_word_details()
        leaderboard = get_leaderboard()

        # Send message to the relevant group
        async_to_sync(self.channel_layer.group_send)(
            group_name,
            {
                'type': 'broadcast_active_users',
                'activeUsers': active_users,
                        'leaderboard': leaderboard
            }
        )
        self.accept()
        self.send(text_data=json.dumps({
            'targetWord': target_word,
            'completedIn': completed_in,
            'completedFrom': completed_from,
            'wordOptions': starter_words,
            'leaderboard': leaderboard,
            'previousTargetWord': previous_target_word
        }))

    def broadcast_active_users(self, data):
        active_users = data['activeUsers']
        leaderboard = data['leaderboard']

        self.send(text_data=json.dumps({
            'activeUsers': active_users,
            'leaderboard': leaderboard
        }))

    def broadcast_new_word(self, data):
        self.send(text_data=json.dumps({
            'targetWord': data['targetWord'],
            'leaderboard': data['leaderboard'],
            'completedFrom': data['completedFrom'],
            'completedIn': data['completedIn'],
            'previousTargetWord': data['previousTargetWord'],
        }))

    def receive(self, text_data):
        data = json.loads(text_data)
        username = self.scope['user'].get_username()
        player = Player.objects.get(name=username)

        # Get clicked word
        clicked_word = data['word']
        # Add clicked word to player's path
        player.add_to_path(clicked_word)
        # Get current target word
        current_target_word = get_target_word()

        # if player selected final word
        if clicked_word == current_target_word:
            # Give player points
            player.points = player.points + len(Player.objects.filter(is_logged_in=True))
            player.save()

            completed_in = len(player.get_path_list())
            completed_from = player.get_path_list()[0]

            # Update copmpleted word entry
            completed_word = TargetWord.objects.get(word=clicked_word)
            completed_word.completed_in = completed_in
            completed_word.completed_from = completed_from
            completed_word.path = player.get_path_list
            completed_word.save()

            # Set a new target word
            new_target_word = set_target_word(current_target_word)

            # Get new leaderboard
            leaderboard = get_leaderboard()

            # Reset player's path
            player.reset_path_list()

            group_name = "online"
            # Send message to the relevant group
            async_to_sync(self.channel_layer.group_send)(
                group_name,
                {
                    'type': 'broadcast_new_word',
                    'targetWord': new_target_word,
                    'leaderboard': leaderboard,
                    'completedFrom': completed_from,
                    'completedIn': completed_in,
                    'previousTargetWord': clicked_word,

                }
            )

        elif clicked_word != current_target_word:
            # Add clicked word to player's path
            player.add_to_path(clicked_word)
            player.save()
            # Get new word options for the player
            word_options = get_word_options(clicked_word, player.get_path_list())

            self.send(text_data=json.dumps({
                'wordOptions': word_options
            }))

    def disconnect(self, close_code):
        # Get player's username
        username = self.scope['user'].get_username()
        # Remove user from group
        group_name = 'online'
        async_to_sync(self.channel_layer.group_discard)(
            group_name,
            self.channel_name
        )

        # Set player's logged in status in DB
        player = Player.objects.get(name=username)
        player.is_logged_in = False
        player.save()

        # Get number of online users
        active_users = len(Player.objects.filter(is_logged_in=True))

        # Send message to the relevant group
        async_to_sync(self.channel_layer.group_send)(
            group_name,
            {
                'type': 'broadcast_active_users',
                'activeUsers': active_users
            }
        )
